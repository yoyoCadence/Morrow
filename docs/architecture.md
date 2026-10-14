# 架構（M0 現況）

這份文件描述**目前已實作**的部分。完整的目標架構與設計理由在 [plans/active-plan.md](plans/active-plan.md)；尚未實作的階段在本文最後列出。

## 形態

Modular monolith：一個 repo、一個 PostgreSQL、兩個進入點。

```text
                   ┌────────────────────────── apps/runtime ──────────────────────────┐
  瀏覽器 ── HTTP ──▶ API 程序（127.0.0.1）                                             │
  （本機）          │   GET /api/health、coverage、證據（唯讀）、靜態 dashboard         │
                   │                                                                  │
  資料供應商 ◀─────── Worker 程序                                                      │
                   │   job loop → ProviderClient → 額度／節流／存證                    │
                   └───────────────────────┬──────────────────────────────────────────┘
                                           ▼
                                   本機 PostgreSQL 17
```

| 套件 | 職責 | 不做的事 |
|---|---|---|
| `packages/core` | 契約（zod schema 與型別）、與供應商無關的純邏輯 | 任何 I/O；任何供應商專屬的型別 |
| `apps/runtime` | 設定、日誌、資料庫、jobs、執行階段、額度、供應商客戶端、API、CLI | 交易、簽署 |
| `apps/web` | Dashboard。以 core 的 schema 驗證 API 的回應；zod 設為 `jitless`，因為 API 的 CSP 不允許 eval | 直接連供應商或資料庫 |

`apps/runtime/src` 的模組：

| 目錄 | 內容 |
|---|---|
| `config/` | 讀取並嚴格驗證環境變數；實盤模式在這裡被拒絕 |
| `logging/` | JSON 日誌與 secret redaction |
| `db/` | 連線池、transaction、migration 執行器、原始證據儲存、稽核紀錄、儲存量測、備份與還原檢查 |
| `events/` | Canonical event 的寫入 |
| `jobs/` | 工作佇列、worker loop 與固定排程（`scheduler.ts`） |
| `session/` | 執行階段、心跳、觀測缺口 |
| `quota/` | 額度政策與帳本 |
| `providers/` | 供應商定義、功能清單、HTTP 客戶端、來源健康狀態、probe |
| `parsers/` | 把已存的供應商回應解析成 canonical events 與欄位 quarantine；只讀已存證據，不連線。單一筆記錄的問題只影響那一筆：無法表示的欄位為 `UNKNOWN`，不符合契約的記錄整筆進 quarantine，同一回應的其他記錄照常產生事件 |
| `api/` | Fastify 伺服器、健康報告、觀測覆蓋、證據檢視與請求日誌的層級 |
| `app/` | 把上述組成 API 與 worker 兩個程序 |
| `cli.ts` | 指令進入點 |

## 兩個程序與單一 worker

API 只讀資料庫，不呼叫供應商。**所有對外的供應商請求都由 worker 發出。**

每個元件同一時間只能有一個執行階段（`run_sessions` 上的 partial unique index）。這讓 worker 內的節流器具有權威性：既然只有一個 worker，行程內的間隔控制就等於全系統的間隔控制，不需要跨行程協調。第二個 worker 啟動時會被拒絕；若前一個已經當掉（沒有心跳、或 pid 已不存在），新的會接手並記錄缺口。

Worker 程序內有兩條隊伍，各自一次只跑一個 job：

| 隊伍 | Job | 原因 |
|---|---|---|
| `network` | 會連線到供應商的 job（目前是 `provider.probe`），以及所有沒有明確宣告為本機的種類 | 供應商請求保持一次一個，經過同一個節流器 |
| `local` | 只讀寫本機資料庫的 job（目前是 `raw.parse`），列在 `LOCAL_JOB_KINDS` | 不會因為一個 15 秒逾時的供應商請求而延遲 |

新的 job 種類預設屬於 `network`；要放進 `local`，必須確定它不會連線到供應商。

## 一個供應商請求的路徑

`ProviderClient.request()` 是系統與資料供應商之間唯一的通道，依序執行：

1. **來源健康檢查**：該功能若在退避中（rate limit 或連續失敗），或處於需要人處理的狀態（`PAYMENT_REQUIRED`、`UNAUTHORIZED`），直接回 `SUPPRESSED`，不碰網路。退避期間任何理由都不能插隊；黏性狀態只有明確的 probe 可以重新測試。
2. **授權**：由供應商定義加上憑證。沒有設定憑證就回 `CREDENTIAL_MISSING`，不送出。
3. **額度**：計量的供應商先向帳本預留。超過本地硬性上限就回 `QUOTA_HARD_STOP`，不送出。
4. **節流**：依供應商的最小間隔排隊。等待之後才以當下時間產生授權（OKX 的簽章帶有時間，排隊期間產生的簽章可能已經過期）。
5. **送出**：有逾時、有回應大小上限、不跟隨 redirect（避免憑證 header 被帶到別的主機）。先依 HTTP 狀態碼分類；供應商定義若有 `readEnvelope`（目前只有 OKX），2xx 回應還要回應本文同意才算 `OK`，本文裡的錯誤依代碼分類。
6. **存證與更新健康狀態**：同一個 transaction 寫入 `raw_observations` 與 `source_health`。結果是 `OK` 且該功能有 parser 時，同一個 transaction 也排入 `raw.parse` job（目前只有 DEX Screener `market.tokens`）。

客戶端自己不重試。重試是一個新的請求，有自己的額度扣除，由工作佇列排程。

憑證只在第 2 步被加進請求，之後不會被儲存或記錄。`RequestSpec`（會被儲存的部分）在型別上就不含憑證。

### 降級對照

| 情況 | 結果 | 後續行為 |
|---|---|---|
| HTTP 429 | `RATE_LIMITED` | 依 `Retry-After` 暫停，至少 30 秒、至多 15 分鐘。限制屬於整個金鑰的供應商（`rateLimitScope: 'provider'`：Jupiter、Helius，以及尚未確認的 OKX），暫停該供應商的所有功能，記錄在 capability 為 `*` 的 `source_health` 列；DEX Screener 依端點限流，只暫停被限流的功能 |
| HTTP 402 | `PAYMENT_REQUIRED` | 保存回應內容；停止自動請求。永不付款、不換帳號 |
| HTTP 401／403 | `UNAUTHORIZED` | 停止自動請求，等人修正憑證後以 probe 重測 |
| 憑證驗證失敗 | `TLS_UNTRUSTED` | 視為來源不可用。不會關閉 TLS 驗證，也不會信任攔截者的憑證 |
| 逾時、連線失敗、5xx | `TIMEOUT`／`NETWORK_ERROR`／`SERVER_ERROR` | 指數退避，5 秒起、5 分鐘封頂 |
| 額度用盡 | `QUOTA_HARD_STOP` | 不送出，直到下一個計費週期 |
| HTTP 404、其他 4xx，或 2xx 本文裡與憑證、額度無關的錯誤 | `NOT_FOUND`／`CLIENT_ERROR`，來源狀態 `REQUEST_REJECTED` | 供應商有回應，所以不退避；但沒有拿到資料，所以不是 `HEALTHY`。連續 3 次以上，health 視為異常 |
| 比例欄位的單位未確認 | 該欄位為 `UNKNOWN (UNIT_UNVERIFIED)` | 不猜測換算 |

### 整體狀態

`GET /api/health` 的每一個問題都是一筆 finding，帶有嚴重度；最嚴重的那一筆決定整體狀態（`HEALTH_LEVELS`）：

| 狀態 | 意義 | 例子 |
|---|---|---|
| `ok` | 沒有要回報的事 | — |
| `attention` | 可以運作，但設定不完整或接近上限 | 沒有憑證、一次被拒絕的請求、額度過警告線、近 24 小時的矛盾事件、時鐘偏移超過 5 秒 |
| `degraded` | 應該運作的東西沒有在運作 | 來源 `DOWN`／限流／權限或付費被拒、程序心跳中斷、需要觀測的模式卻沒有 worker、額度硬停、dead job、連續被拒絕的功能、時鐘偏移超過 30 秒 |
| `critical` | 報告本身不可信，或什麼都無法執行 | 資料庫無法連線、migration 狀態與程式不符或尚未套用 |

## 資料庫

Migration 在 [apps/runtime/migrations](../apps/runtime/migrations)，每個檔案一個 transaction，已套用的檔案不可修改（以 checksum 檢查）。

| 資料表 | 性質 | 內容 |
|---|---|---|
| `raw_payloads` | append-only | 回應本文，以 SHA-256 定址，相同內容只存一份 |
| `raw_observations` | append-only | 每一個實際送出的請求，不論成敗 |
| `events` | append-only | Canonical events，以 `dedupe_key` 去重 |
| `jobs` | 可變 | 工作佇列，同時也是 transactional outbox |
| `consumer_inbox` | 只增 | Consumer 端去重 |
| `run_sessions` | 可變 | 執行階段與心跳 |
| `session_gaps` | append-only | 沒有在觀測的時段 |
| `schedule_state` | 可變 | 每個固定排程目前到哪個 slot、上一個 job、是否積壓中（投影，`0006`） |
| `schedule_gaps` | append-only | 固定排程沒有執行的 slot，每一段一列，附原因（`0006`） |
| `quota_counters` | 可變 | 每個額度桶在每個計費週期的累計用量 |
| `quota_events` | append-only | 每一次額度預留的嘗試，包含被拒絕的 |
| `source_health` | 可變 | 每個供應商功能的目前狀態（投影） |
| `provider_probes` | append-only | 每一次權限探測的結果 |
| `audit_log` | append-only | 操作與狀態變更 |
| `event_conflicts` | append-only | 同一個 `dedupe_key` 卻說了不同事實的事件，原樣保存（`0004`）。`events.fact_sha256` 是判斷依據 |
| `parse_quarantine` | append-only | Parser 收到但不猜測解讀的欄位（例如單位未確認），保存原文與原因（`0002`） |

Append-only 的表以 trigger 擋下 `UPDATE`、`DELETE`、`TRUNCATE`。

### 備份

`npm run backup`（`db/backup.ts`，FT-06）。一次備份分三步：

1. 在一個 `REPEATABLE READ` 的 transaction 裡 export snapshot，讀出每張表的列數、trigger 與已套用的 migration。
2. `pg_dump --snapshot` 用同一個 snapshot 傾印 `public` schema（custom format，不含 owner 與權限），所以 manifest 與傾印描述的是同一份資料，worker 繼續寫入也一樣。
3. 傾印先寫成 `.partial`，完成後才改名。旁邊的 manifest（JSON）記錄大小、SHA-256 與上述內容。

接著還原到 `<資料庫>_restore_check`（先刪掉同名 schema；archive 的目錄沒有建立該 schema 時才自己建立，因為 pg_dump 是否把 `public` 本身寫進 archive 依傾印方式與版本而定），核對 SHA-256、每張表的列數、trigger 與 migration。通過後刪掉還原出來的 schema，並在 manifest 記下 `restore_check`；不符時保留它供檢查。還原的目標名稱由程式推導、必定以 `_restore_check` 結尾，且在刪除任何東西之前以 `current_database()` 再確認一次，所以不會覆蓋使用中的資料庫。連線資訊以 `PG*` 環境變數傳給 pg_dump／pg_restore，密碼不會出現在程序清單；工具版本必須不舊於伺服器。

各表的成長以 `npm run storage` 量測；保留策略見 [ADR-0001](adr/0001-storage-retention.md)（提案中）。新增資料表時，要在 `db/storage.ts` 的 `STORAGE_TIME_COLUMNS` 登記它的時間欄位（或 `null`），否則測試會失敗。

### 工作佇列的語意

- **At-least-once**。`FOR UPDATE SKIP LOCKED` 讓多個 worker 各拿不同的工作；租約過期的工作會被重新派發。
- **續租**。租約預設 300 秒，執行中的 job 每三分之一租約續租一次，所以只有停止或凍結的 worker 會失去租約。續租失敗（被別人取走）時記錄 warning；做完時不會把它記為成功。
- **Transactional outbox**：工作與造成它的資料在同一個 transaction 寫入。Transaction 回滾，工作就不存在；提交了，工作就不會遺失。
- **冪等**：帶 `dedupe_key` 的工作只會被建立一次。Handler 用 `consumer_inbox` 在同一個 transaction 內記錄「已處理」，所以重送不會重複產生效果。
- 失敗會延遲重試，次數用完後進入 `dead`。

這不是 exactly-once。對外部系統有副作用的 handler 必須自己能安全地重複執行。

### 固定排程

`jobs/scheduler.ts`（FT-03）。藍圖的「固定排程」（例如 Jupiter recent 每 60 秒、OKX hot-token 每 5 分鐘）以 `Schedule` 宣告：名稱、job 種類、slot 長度。在 `app/processes.ts` 的 `defaultSchedules` 登記，handler 照常在 `defaultHandlers` 登記；目前兩者都還沒有任何排程。

- **Slot**：時間依 slot 長度切段，對齊 UTC epoch（5 分鐘的排程在 :00、:05…，與 worker 何時啟動無關）。每個 slot 至多一個 job，dedupe key 是 `schedule:<名稱>:<slot 開始時間>`，payload 帶 `schedule` 與 `slot_start`。一個排程是每個 slot 一個 job，不是每個 token 一個；涵蓋多個對象（六個 active tokens、warm universe）的 handler 自己逐一處理。
- **不補發**：觀測描述的是送出請求的那一刻，晚跑的 slot 拿到的是現在的資料，補不回錯過的時段。所以停機（或資料庫連不上）後只跑目前的 slot，錯過的 slot 記成一列 `NOT_SCHEDULED` 缺口。
- **不堆積**：新的 slot 開始時，上一個 slot 的 job 若還沒開始執行（仍是 `queued`），這個 slot 就跳過，不排在它後面；連續跳過的 slot 在積壓結束時記成一列 `BACKLOG` 缺口。所以每個排程最多一個在執行、一個在等。跳過的原因改變時（例如積壓中時鐘出問題），前一段在那裡結束，另起一段。
- **時鐘不可信時暫停**：上述偏移的中位數超過 30 秒（不論快慢）時，新的 slot 不排入，記成 `CLOCK_SKEW` 缺口（藍圖 fail-safe：clock drift 超標時，恢復可信 freshness 後才繼續）。偏移未知（近 30 分鐘少於 3 筆回應）時不暫停：偏移只能從供應商的回應量測，未知就暫停會永遠等不到量測。代價是時鐘壞掉時，每當舊的量測過期（約 30 分鐘），會再送出幾個請求，量到偏移後再次暫停。`CLOCK_SKEW` 缺口的時間來自那個不準的時鐘。
- **預設不重試**（`maxAttempts` 1）：下一個 slot 就是重試。
- 只在 `RESEARCH`／`PAPER` 模式執行。`OFF` 期間的 slot，在之後以 `RESEARCH`／`PAPER` 啟動時記成 `NOT_SCHEDULED`。排程的 job 種類沒有 handler 時，worker 拒絕啟動（否則那個 job 永遠在等，之後每個 slot 都會被跳過）。
- 每秒檢查一次；只有 slot 邊界過了才碰資料庫。狀態列以 `FOR UPDATE` 鎖住，加上 dedupe key，同一個 slot 只會排一次。
- 缺口目前只記錄，health 與儀表板還沒有顯示；第一個真正的排程加入時一起做（tasks.md）。

### 時鐘偏移

每個回應的 `Date` header 存在 `raw_observations.server_date`（`0005`），同時存一個偏移估計 `clock_offset_ms`：`server_date + 500 ms` 減去「送出請求」與「收到回應 header」的中點。用 header 而不是 body 讀完的時間，否則傳輸緩慢的 body 會被算成時鐘偏移；加 500 ms 是因為 Date header 被截斷到秒。欄位是 bigint：時鐘差好幾年（例如主機板電池沒電）也要記得下來，不能溢位。Health 以近 30 分鐘、最多 20 筆的中位數估計本機時鐘與供應商的差（`clock.skew_ms`，正值表示本機較慢）；少於 3 筆時為 null，代表未知，不是 0。Date header 只有一秒的解析度，所以 5 秒以內視為雜訊。偏移超標時依賴資料新鮮度的工作必須停止，這是藍圖 fail-safe 的要求：固定排程在偏移超過 30 秒時暫停新的 slot（見下方「固定排程」）；之後的策略也要遵守。

### 逾時

每一條連線都有上限，所以資料庫出問題時，程序會得到錯誤，而不是無限期等待（[db/pool.ts](../apps/runtime/src/db/pool.ts)）：

| 設定 | 值 | 作用 |
|---|---|---|
| `connectionTimeoutMillis` | 10 秒 | 建立連線的上限 |
| `statement_timeout` | 30 秒（migration 為 0） | 伺服器端：單一語句的執行與等待 lock 的時間 |
| `query_timeout` | 40 秒 | 本程序等待回應的上限；處理伺服器無法察覺的斷線（例如休眠後的半開連線）。逾時的連線會被銷毀，不回到 pool |
| `idle_in_transaction_session_timeout` | 60 秒 | 被遺忘的 transaction 由伺服器結束，釋放 lock |
| TCP keepalive | 10 秒後開始 | 察覺閒置連線的對端已消失 |
| 心跳 | 5 秒 | 心跳自己的語句上限，遠低於 30 秒的存活門檻；一次卡住只會讓那次心跳失敗，下一次照常 |

### 時間

所有時間以 UTC 儲存，UI 顯示 Asia/Taipei。每筆觀測分開保存三個時間：

- `event_time`：來源說這件事何時發生。來源沒給就是 null，不會用抓取時間頂替。
- `observed_at`：我們何時收到。
- `available_at`：何時寫入資料庫、可被決策使用，由資料庫在寫入當下指定。Replay 以它為截止點，所以補抓的舊資料不會被當成「當時就知道」。

## 執行階段與觀測缺口

系統只在電腦開機時運作。任何沒有在觀測的時段都會被明確記錄，而不是讓缺資料看起來像「沒有事發生」：

| 缺口類型 | 何時產生 |
|---|---|
| `OFFLINE` | 乾淨停止之後，到下一次啟動之間 |
| `UNCLEAN_SHUTDOWN` | 前一個執行階段沒有正常結束；從它最後一次心跳算起 |
| `HEARTBEAT_STALL` | 同一個執行階段內兩次心跳間隔超過 30 秒（休眠、凍結） |

Health 不只看 `run_sessions.status`：程序被強制終止後，紀錄會一直是 `RUNNING`，直到該元件下一次啟動。所以 health 以資料庫時鐘計算心跳的年齡，超過 30 秒就把該 session 標為 `STALE`（推導出來的狀態，不改寫紀錄），整體狀態降級；`RESEARCH`／`PAPER` 模式下沒有 `LIVE` 的 worker，也會降級。

觀測覆蓋（`GET /api/coverage?hours=24|168`，`api/coverage.ts`）把這些紀錄換算成時間軸：worker 在 `RESEARCH`／`PAPER` 模式下、有心跳的時間算觀測中，其餘每一段都有原因（上表三種，加上 `HEARTBEAT_LOST`：仍標為 `RUNNING` 但已沒有心跳、下一次啟動前尚未記錄的那段；`MODE_OFF`；`NO_RECORD`：什麼紀錄都沒有，例如第一次啟動之前）。重新啟動時，缺口的結束時間與新 session 的開始時間來自兩次讀取時鐘，中間會差幾毫秒；短於 1 秒且沒有紀錄的縫隙併入前一段，不算缺口。

停止程序有兩種方式：終端機內按 Ctrl+C，或執行 `npm run stop`。後者在資料庫寫入停止請求，程序在下一次心跳（5 秒內）讀到後乾淨結束。Windows 沒有可用的 SIGTERM，所以沒有主控台的程序要用這個方式停止。

## 本機 API

- 只綁 `127.0.0.1`，不可設定。
- `Host` header 必須是本伺服器的位址（防 DNS rebinding）。
- 若有 `Origin` header，必須是本伺服器（防其他網站從瀏覽器呼叫）。
- 唯讀端點：`GET /api/health`（健康報告）、`GET /api/coverage?hours=24|168`（觀測覆蓋；其他時間長度回 400，資料庫錯誤回 503，原因只寫在日誌）。
- 證據（FT-01，`api/evidence.ts`，契約見 [contracts.md](contracts.md)）：
  - `GET /api/events?subject=&before=&limit=`：某個 subject（或全部）的事件，新的在前。
  - `GET /api/raw-observations?provider=&capability=&before=&limit=`：送出過的請求。
  - `GET /api/raw-observations/:id`：單筆請求的本文（最多 256 KiB）、從它 quarantine 的欄位，以及引用它的事件。
  - `GET /api/quarantine?reason=&before=&limit=`：quarantine 的欄位。
  - 參數不合法時回 400，`error` 指出是哪一個（`INVALID_SUBJECT`、`INVALID_LIMIT`、`INVALID_CURSOR`、`INVALID_FILTER`、`INVALID_ID`）；查無該筆回 404；資料庫錯誤回 503 `EVIDENCE_UNAVAILABLE`，原因只寫在日誌。
  - 來自供應商的每一段文字（本文、URL、content type、錯誤類別與訊息、quarantine 的原文與位置）在送出前經過與日誌相同的 redactor：已知的憑證值與看起來像憑證的參數會被替換。資料庫裡的原始位元組是證據，不會改動。
- 目前只接受 `GET`／`HEAD`。寫入端點必須連同 session 與 CSRF 防護一起加入（M3）。

## 尚未實作

以下在藍圖中有設計，程式碼還不存在：

- DEX Screener `tokens/v1` 以外的供應商回應 parser 與 adapter（M1、M2）
- Asset、Wallet、Entity、Cluster、Candidate 等契約與資料表（M1、M2）
- Paper ledger、quote model、risk、reservation、replay（M1）
- Discovery、排序、cohort inventory（M2）
- ResearchPacket、thesis、signals、sizing、Telegram（M3）
- 完整 dashboard、session recovery（游標與回補）、自動定期備份與災後還原程序、attribution（M4）
- 定期工作：排程器已就緒（FT-03），但還沒有登記任何排程；藍圖的固定排程隨各自的 handler 加入

已知的後續強化項目列在 [tasks.md](../tasks.md) 的 Backlog。
