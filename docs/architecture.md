# 架構（M0 現況）

這份文件描述**目前已實作**的部分。完整的目標架構與設計理由在 [plans/active-plan.md](plans/active-plan.md)；尚未實作的階段在本文最後列出。

## 形態

Modular monolith：一個 repo、一個 PostgreSQL、兩個進入點。

```text
                   ┌────────────────────────── apps/runtime ──────────────────────────┐
  瀏覽器 ── HTTP ──▶ API 程序（127.0.0.1）                                             │
  （本機）          │   GET /api/health、靜態 dashboard                                │
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
| `apps/web` | Dashboard。只 `import type` core 的型別 | 直接連供應商或資料庫 |

`apps/runtime/src` 的模組：

| 目錄 | 內容 |
|---|---|
| `config/` | 讀取並嚴格驗證環境變數；實盤模式在這裡被拒絕 |
| `logging/` | JSON 日誌與 secret redaction |
| `db/` | 連線池、transaction、migration 執行器、原始證據儲存、稽核紀錄 |
| `events/` | Canonical event 的寫入 |
| `jobs/` | 工作佇列與 worker loop |
| `session/` | 執行階段、心跳、觀測缺口 |
| `quota/` | 額度政策與帳本 |
| `providers/` | 供應商定義、功能清單、HTTP 客戶端、來源健康狀態、probe |
| `api/` | Fastify 伺服器與健康報告 |
| `app/` | 把上述組成 API 與 worker 兩個程序 |
| `cli.ts` | 指令進入點 |

## 兩個程序與單一 worker

API 只讀資料庫，不呼叫供應商。**所有對外的供應商請求都由 worker 發出。**

每個元件同一時間只能有一個執行階段（`run_sessions` 上的 partial unique index）。這讓 worker 內的節流器具有權威性：既然只有一個 worker，行程內的間隔控制就等於全系統的間隔控制，不需要跨行程協調。第二個 worker 啟動時會被拒絕；若前一個已經當掉（沒有心跳、或 pid 已不存在），新的會接手並記錄缺口。

## 一個供應商請求的路徑

`ProviderClient.request()` 是系統與資料供應商之間唯一的通道，依序執行：

1. **來源健康檢查**：該功能若在退避中（rate limit 或連續失敗），或處於需要人處理的狀態（`PAYMENT_REQUIRED`、`UNAUTHORIZED`），直接回 `SUPPRESSED`，不碰網路。退避期間任何理由都不能插隊；黏性狀態只有明確的 probe 可以重新測試。
2. **授權**：由供應商定義加上憑證。沒有設定憑證就回 `CREDENTIAL_MISSING`，不送出。
3. **額度**：計量的供應商先向帳本預留。超過本地硬性上限就回 `QUOTA_HARD_STOP`，不送出。
4. **節流**：依供應商的最小間隔排隊。
5. **送出**：有逾時、有回應大小上限、不跟隨 redirect（避免憑證 header 被帶到別的主機）。
6. **存證與更新健康狀態**：同一個 transaction 寫入 `raw_observations` 與 `source_health`。

客戶端自己不重試。重試是一個新的請求，有自己的額度扣除，由工作佇列排程。

憑證只在第 2 步被加進請求，之後不會被儲存或記錄。`RequestSpec`（會被儲存的部分）在型別上就不含憑證。

### 降級對照

| 情況 | 結果 | 後續行為 |
|---|---|---|
| HTTP 429 | `RATE_LIMITED` | 依 `Retry-After` 暫停，至少 30 秒、至多 15 分鐘 |
| HTTP 402 | `PAYMENT_REQUIRED` | 保存回應內容；停止自動請求。永不付款、不換帳號 |
| HTTP 401／403 | `UNAUTHORIZED` | 停止自動請求，等人修正憑證後以 probe 重測 |
| 憑證驗證失敗 | `TLS_UNTRUSTED` | 視為來源不可用。不會關閉 TLS 驗證，也不會信任攔截者的憑證 |
| 逾時、連線失敗、5xx | `TIMEOUT`／`NETWORK_ERROR`／`SERVER_ERROR` | 指數退避，5 秒起、5 分鐘封頂 |
| 額度用盡 | `QUOTA_HARD_STOP` | 不送出，直到下一個計費週期 |
| 比例欄位的單位未確認 | 該欄位為 `UNKNOWN (UNIT_UNVERIFIED)` | 不猜測換算 |

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
| `quota_counters` | 可變 | 每個額度桶在每個計費週期的累計用量 |
| `quota_events` | append-only | 每一次額度預留的嘗試，包含被拒絕的 |
| `source_health` | 可變 | 每個供應商功能的目前狀態（投影） |
| `provider_probes` | append-only | 每一次權限探測的結果 |
| `audit_log` | append-only | 操作與狀態變更 |

Append-only 的表以 trigger 擋下 `UPDATE`、`DELETE`、`TRUNCATE`。

### 工作佇列的語意

- **At-least-once**。`FOR UPDATE SKIP LOCKED` 讓多個 worker 各拿不同的工作；租約過期的工作會被重新派發。
- **Transactional outbox**：工作與造成它的資料在同一個 transaction 寫入。Transaction 回滾，工作就不存在；提交了，工作就不會遺失。
- **冪等**：帶 `dedupe_key` 的工作只會被建立一次。Handler 用 `consumer_inbox` 在同一個 transaction 內記錄「已處理」，所以重送不會重複產生效果。
- 失敗會延遲重試，次數用完後進入 `dead`。

這不是 exactly-once。對外部系統有副作用的 handler 必須自己能安全地重複執行。

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

停止程序有兩種方式：終端機內按 Ctrl+C，或執行 `npm run stop`。後者在資料庫寫入停止請求，程序在下一次心跳（5 秒內）讀到後乾淨結束。Windows 沒有可用的 SIGTERM，所以沒有主控台的程序要用這個方式停止。

## 本機 API

- 只綁 `127.0.0.1`，不可設定。
- `Host` header 必須是本伺服器的位址（防 DNS rebinding）。
- 若有 `Origin` header，必須是本伺服器（防其他網站從瀏覽器呼叫）。
- 目前只接受 `GET`／`HEAD`。寫入端點必須連同 session 與 CSRF 防護一起加入（M3）。

## 尚未實作

以下在藍圖中有設計，程式碼還不存在：

- 供應商回應的 parser 與 adapter（M1、M2）
- Asset、Wallet、Entity、Cluster、Candidate 等契約與資料表（M1、M2）
- Paper ledger、quote model、risk、reservation、replay（M1）
- Discovery、排序、cohort inventory（M2）
- ResearchPacket、thesis、signals、sizing、Telegram（M3）
- 完整 dashboard、session recovery（游標與回補）、備份還原、attribution（M4）
- 排程器：目前沒有任何定期工作

已知的後續強化項目列在 [tasks.md](../tasks.md) 的 Backlog。
