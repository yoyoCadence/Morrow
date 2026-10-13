# 專案審查：架構、測試、UI 與功能建議（2026-10-13）

審查基準：`main` @ `c3ca26b`（PR #5 合併後）。審查人：Claude Code（agent），應操作人要求進行。

這份文件是一次性的審查紀錄，不是新的狀態文件。可派工的項目已寫進 [tasks.md](../../tasks.md)（`RV-`、`UI-`、`FT-` 開頭）；目前狀態與證據仍以 [PROJECT_STATUS.md](../../PROJECT_STATUS.md) 為準。

## 0. 結論先講

1. **工程品質高，地基可信。** 契約、append-only 證據、交易性 outbox、額度帳本、session 缺口、secret redaction 都有真實 PostgreSQL 測試把關，170 個測試全部通過。這不是需要重寫的專案。
2. **但「誠實呈現」這個核心承諾有 4 個破口**，都已重現：
   - worker 當掉後，dashboard 仍顯示綠色 `RUNNING`，整體狀態「運作正常」。
   - 一筆格式極端但合法的數值，會讓整個回應的解析失敗，連帶丟掉同一回應裡正常的 pair。
   - 端點一直回 404，或 OKX 用 HTTP 200 回傳未列入對照表的錯誤碼時，來源顯示綠色 `HEALTHY`。
   - 資料庫連線沒有逾時，查詢可能無限期卡住。
3. **M2 之前必須先決定儲存策略。** 依藍圖排程估算，每月約 430 萬筆 pair snapshot 事件，加上約 3,400 萬筆 quarantine 列。現在沒有保留期限，也沒有備份。
4. **流程有漂移。** PR #5（DEX Screener parser＋migration 0002）不在任務看板上，合併後也沒有更新 tasks.md、PROJECT_STATUS、architecture、contracts。Repo 沒有 CI，也沒有 linter／formatter。
5. **最大的阻礙不是程式。** 從 2026-10-05 起，M1 唯一的阻礙是免費 API 憑證。這件事估計 30–60 分鐘就能完成，卻已經擱置 8 天；這段期間做的都是周邊工作。見 §7。

## 1. 審查範圍與方法

| 項目 | 內容 |
|---|---|
| 程式碼 | 逐檔閱讀 `packages/core`、`apps/runtime`（含 2 個 migration）、`apps/web`，約 10,350 行（含測試） |
| 文件 | AGENTS.md、tasks.md、PROJECT_STATUS.md、ROADMAP.md、README、`docs/` 全部，含 690 行藍圖 |
| 環境 | Linux 雲端容器、Node 24.19.0（官方 tarball，SHA-256 已驗證）、**PostgreSQL 16.15**（容器內只有 16；專案目標是 17） |
| 執行 | `npm ci`、`npm run typecheck`、`npm run build`、`npm test`、`npm audit` |
| 重現 | 對編譯後的程式寫一次性腳本，在獨立 schema 中重現疑似問題（腳本不進 repo） |
| UI | 實際啟動 API 與 worker（`OFF` 模式），灌入具代表性的狀態，以無頭 Chromium 截圖：桌面亮色、深色、390 px 手機；另外 `kill -9` worker 後再截圖 |
| 未做 | 沒有連到任何真實供應商；沒有在 Windows 上執行；沒有做長時間 session |

## 2. 驗證結果

| 檢查 | 結果 |
|---|---|
| `npm run typecheck` | 通過 |
| `npm run build` | 通過；dashboard bundle 227 KB（gzip 71 KB） |
| `npm test` | **170／170 通過**（core 26、runtime 不需 DB 55、DB 測試 89），約 24 秒 |
| `npm audit` | 1 個 high：`source-map-js@1.2.1`（GHSA-68fv-2mgg-jv7q），經 `vite → postcss` 進來，只在建置時使用，不進執行期 |
| 執行中的 dashboard | 三種版面都沒有 console error，也沒有頁面層級的水平捲動 |

PROJECT_STATUS 記錄的是 153 個測試，已經過時：PR #5 新增了 17 個。

## 3. 已確認的問題

嚴重度只依「對系統誠實性與資料的影響」分級，不依修改難度。

| ID | 嚴重度 | 問題 | 證據 | 位置 |
|---|---|---|---|---|
| R1 | **高** | Worker 當掉後（`kill -9`），session 仍是 `RUNNING`。直到下一次啟動才會被標成 `ABANDONED`。Health 不檢查心跳是否過期，所以整體狀態是 `ok`，dashboard 顯示綠色 `RUNNING` | 重現腳本：心跳 10 分鐘前、`status=ok`。實機：worker 被終止 93 秒後截圖仍是綠色 RUNNING；之後 `npm run stop` 對這個已不存在的 worker 等了 30 秒，回報「may be busy or frozen」 | `api/health.ts:120`、`web/src/App.tsx:107`、`cli.ts` 的 `commandStop` |
| R2 | **高** | 從未啟動過 worker 時，health 也是 `ok`。`RESEARCH`／`PAPER` 模式下沒有 worker，就等於沒有在觀測 | 重現：`sessions=0`、`status=ok` | `api/health.ts:120` |
| R3 | **高** | 單一 pair 的數值格式極端但合法時（例如 `priceUsd: "1e-120"`，展開後超過 `DecimalString` 的 96 字元），`PairSnapshot.parse` 丟出 ZodError，整個回應都解析失敗：同一回應裡正常的 pair 也沒有事件。Job 會重試 5 次（同樣的輸入必然失敗）再進 `dead` | 重現：兩個 pair、一個正常一個極端，結果是 ZodError、0 個事件 | `parsers/dexscreener-tokens.ts:173` |
| R4 | 中 | `NOT_FOUND`，以及所有 `CLIENT_ERROR`（包含 OKX 的 `OKX_NO_ENVELOPE`、`OKX_INVALID_JSON` 與未列入對照表的錯誤碼），都把來源設成 `HEALTHY`。一個永遠回 404 的端點，在 dashboard 上是綠燈，整體狀態也是 `ok` | 重現：OKX `code 51000` → `HEALTHY`；404 → `HEALTHY`、`last_success_at = null`、`status=ok`。截圖中 `jupiter/tokens.recent` 與 `okx/market.trades` 皆為綠色 | `providers/source-health.ts:72-82` |
| R5 | 中 | `pg.Pool` 沒有設定 `connectionTimeoutMillis`、`statement_timeout`、`keepAlive`。半開的 TCP 連線（休眠喚醒後很常見），或卡住的 lock，會讓查詢無限期等待。心跳因為 `busy` 旗標，會在第一次卡住之後完全停止 | 重現：連到黑洞位址，`SELECT 1` 8 秒後仍在等待 | `db/pool.ts:19` |
| R6 | 中 | 同一個 `dedupe_key` 再次寫入、但 payload 不同時，第二筆被直接丟棄，不留任何紀錄。這是「矛盾資料」，不是「重複資料」，應該能被看見（`CONFLICTING`） | 重現：`inserted=false`，沒有 audit、沒有 conflict 紀錄 | `events/event-store.ts:26` |
| R7 | 低 | 契約允許任意精度的 `confidence`，資料庫欄位是 `numeric(7,6)`，所以會被靜默四捨五入。目前還沒有 producer 會設定 confidence | 重現：送 `0.1234567`、存成 `0.123457` | `migrations/0001_foundation.sql:117` |
| R8 | 低（待核實） | OKX 錯誤碼對照表沒有 `50101`、`50102`。依 OKX v5 公開錯誤碼表，50102 是「Timestamp request expired」，也就是本機時鐘偏移會造成的錯誤。目前會被歸類成 `CLIENT_ERROR`，再因為 R4 顯示成 `HEALTHY`。Web3 API 是否沿用相同代碼，要用真實憑證確認 | 程式碼閱讀 | `providers/okx-envelope.ts:4` |
| R9 | 低 | OKX 的簽章時間戳在等額度、等節流**之前**就產生了（`authorize` 在 `limiter.acquire()` 前呼叫）。目前 worker 是序列執行，延遲不會超過一個間隔；之後若有並行或排隊，就可能超過 OKX 的時間窗 | 程式碼閱讀 | `providers/client.ts:171`、`:195` |

### 設計缺口（不是 bug，但會在 M2 變成 bug）

| ID | 問題 | 影響 |
|---|---|---|
| D1 | Rate limit 退避以「功能」為單位，但 Jupiter（1 RPS）與 Helius 的限制是整個帳號共用。一個功能被 429，其他功能照樣送出 | M2 同時輪詢 3 個 Jupiter 功能時會連續撞限 |
| D2 | Worker 一次只跑一個 job，網路請求與本機解析排在同一條隊伍。15 秒逾時的請求會讓 parse job 跟著等 | 資料新鮮度漂移，parse 延遲隨供應商延遲放大 |
| D3 | Job 租約固定 300 秒，沒有續租。長時間的 job（例如分批回補）會被重新派發 | 同一個 job 同時跑兩份 |
| D4 | `jobs`、`consumer_inbox` 只增不減；`jobs.dedupe_key` 是「永遠唯一」，排程需要 slot 化的鍵（例如 `schedule:<名稱>:<slot>`） | 每分鐘一個 job，一個月約 4.3 萬列；目前還沒有排程器 |
| D5 | **儲存放大**：每個 pair snapshot 約 2.2 KB 事件 JSON，加上約 8 筆 quarantine 列（volume、priceChange 的單位未確認，每次都會進 quarantine）。依藍圖排程（300 個 warm 資產每 5 分鐘、6 個 active 每 60 秒，假設每個資產平均 1.5 個 pair）估算：每天約 14 萬筆事件、114 萬筆 quarantine 列；**每月約 430 萬筆事件、3,400 萬筆 quarantine 列**，粗估量級是十幾 GB，而且沒有備份 | 筆電磁碟、備份時間、查詢效能 |
| D6 | 藍圖的 fail-safe 矩陣有「Clock drift 超標 → 停止」，但目前沒有任何地方量測時鐘偏移。供應商回應的 `Date` header 可以免費取得 | 違反藍圖；也是 R8 的根因 |
| D7 | Health 只有 `ok`／`degraded` 兩級。沒有憑證（`CREDENTIAL_MISSING`）就永遠是 `degraded`，資料庫斷線也是 `degraded`，兩者無法區分 | 警示疲勞：操作人會學會忽略「部分異常」 |

## 4. 架構評估

**原則**：一個號稱「可稽核、不假裝」的系統，價值在於任何畫面上的判斷都能追到原始證據，而且「不知道」永遠不會被畫成「沒事」。

**邏輯**：用這個標準檢查，資料路徑（provider → raw → event）做得很好；觀測路徑（health → dashboard）比較弱。前者有完整的狀態語意（`KNOWN／UNKNOWN／STALE…`），後者卻把「最後一次寫入的狀態」直接當成「現在的狀態」。R1、R2、R4、D7 都是同一個根因：**health 沒有自己的新鮮度語意**。

**做得好、應該保留的**：

- 唯一的供應商通道 `ProviderClient.request()`：健康檢查 → 授權 → 額度 → 節流 → 送出 → 存證，順序正確，失敗也存證，憑證在型別上就無法進入儲存。
- 內容定址的 `raw_payloads`、資料庫指定的 `available_at`、與 dedupe key 決定性綁定的 `event_id`：replay 的基礎已經到位。
- `JSON.parse` 的 source-text reviver：數字從頭到尾不經過浮點數。這是正確且少見的做法。
- 以 trigger 強制 append-only、以 partial unique index 保證單一 worker，讓行程內的節流器具有權威性。
- 測試直接打真實 PostgreSQL，每個檔案用自己的 schema，並發、回滾、租約過期都有覆蓋。

**需要調整的**（依時間點排序）：

1. **現在**：health 加上新鮮度語意（R1、R2、R4、D7）。這是 dashboard 能否被信任的前提。
2. **M2 之前**：儲存策略（D5）、排程器與 slot 化 dedupe（D4）、provider 層級退避（D1）、worker 分成「網路」與「本機」兩條隊伍，仍在同一個程序內（D2）。
3. **M3 之前**：DB 角色分離（已在 Backlog）。目前執行期的角色就是 table owner，可以 `ALTER TABLE … DISABLE TRIGGER`，所以 append-only 擋得住程式錯誤，擋不住惡意或誤操作。

**不建議做的**：引入 Redis、Kafka 或拆服務。目前的量級（每天十幾萬列）PostgreSQL 綽綽有餘，瓶頸在儲存策略，不在吞吐量。

## 5. 測試評估

**優點**：170 個測試對真實 PostgreSQL 執行，涵蓋並發預留不超額、回滾不留孤兒 job、租約過期重派、append-only、secret 不外洩、live mode 被拒。測試名稱就是規格，可讀性很好。

**缺口**：

| 缺口 | 說明 | 建議 |
|---|---|---|
| 沒有 CI | 測試只在操作人想到時才在本機跑。PR #1–#5 都是在沒有自動化關卡的情況下合併 | GitHub Actions＋PostgreSQL 17 service，跑 typecheck、build、test（RV-05） |
| 前端 0 個測試 | Dashboard 的狀態判斷（例如心跳是否過期）一旦加上，就是邏輯，需要測試 | 抽出純函式用 `node:test` 測；CI 加一個 Playwright 冒煙測試 |
| Health 不測新鮮度 | 因為功能本身不存在 | 隨 RV-01 加入 |
| Parser 只有一份真實樣本 | 只有 wrapped SOL 的回應（1 個 pair）。Meme token 常缺 `liquidity`、帶 `boosts`、`pairCreatedAt` 為 null | 憑證到位、開始輪詢後，收集 5–10 份不同型態的真實回應當 fixture |
| 沒有對抗性輸入測試 | 極端指數、超長字串、深層巢狀、8 MB 邊界 | RV-02 加入；可用固定 seed 的簡易 fuzz，不需要新相依 |
| 沒有覆蓋率數字 | Node 24 內建 `--experimental-test-coverage`，不需新套件 | 先量測、不設門檻 |
| 只在 PostgreSQL 17（Windows）與 16（本次）驗證 | — | CI 固定 17 |

## 6. UI 與視覺

### 現況（截圖觀察）

- 結構清楚：Paper-only 橫幅、資料庫、程序、觀測缺口、資料來源、額度、工作佇列，都有一句說明。深色模式有完整的 token。
- 時間一律顯示台北時間，與契約一致。

### 問題

| ID | 問題 | 觀察 |
|---|---|---|
| U1 | 心跳過期仍顯示綠色 RUNNING | 同 R1 |
| U2 | 1280 px 桌面寬度下，「資料來源」表格被截斷，「最近成功」欄只剩半個時間 | `th, td { white-space: nowrap }` 加上完整的「年/月/日 時:分:秒」 |
| U3 | 390 px 手機寬度下，每張表都要在卡片內水平捲動，「狀態」欄第一眼看不到 | 表格沒有窄螢幕版面 |
| U4 | 整體狀態只有黃色「部分異常」；資料庫斷線、額度硬停、dead job 也一樣是黃色 | 同 D7 |
| U5 | `useHealth` 存了 `fetchedAt`，畫面上卻沒有顯示。操作人無法判斷畫面是 2 秒前還是 2 分鐘前的資料 | `useHealth.ts:24` |
| U6 | OKX 的錯誤顯示成「UNAUTHORIZED（HTTP 200）」，看起來自相矛盾；真正的原因（`OKX_CODE_50113`）沒有出現在 health 回應裡 | API 沒有提供 `error_class` |
| U7 | 額度條在 `HARD_STOP` 時是黃色、旁邊的徽章是紅色，顏色不一致；也看不出何時會用完 | `<meter>` 由瀏覽器上色 |
| U8 | 輪詢沒有逾時、不會取消上一個請求；分頁在背景時照樣每 10 秒請求；回應不經 schema 驗證，API 與 UI 的契約漂移不會被發現 | `useHealth.ts` |
| U9 | API 對每個 health 請求寫 2 行 info 日誌，開著分頁每天約 1.7 萬行 | `server.ts:41` |

### 提升方向

**原則**：這是操作工具，不是交易終端。視覺要先回答「我現在能不能相信這個畫面」，再回答「發生了什麼」。

**邏輯**：藍圖的 anti-FOMO 原則同樣適用於 UI 本身。紅綠閃爍的價格、漲幅排行榜、倒數計時器，會強化追高的衝動；而這個系統最想避免的，就是根據未經驗證的熱度採取行動。所以「視覺效果」應該花在新鮮度、覆蓋率與不確定性的呈現，不是動態感。

**具體做法**（已拆成 `UI-01`～`UI-10`）：

1. **頁首狀態列**：四級整體狀態（正常／需注意／異常／嚴重），旁邊是幾個小指標：worker 心跳、來源健康數（例如 7/13）、最高額度使用率、dead job 數。分頁標題與 favicon 跟著狀態變化，切到別的分頁也看得到。
2. **新鮮度一律相對時間**：「12 秒前」，滑鼠移上去才顯示完整時間。超過門檻就降級成「疑似停止」並變色。「上次更新」與一個很小的、會暫停的更新指示點，放在頁首。
3. **觀測覆蓋帶**：近 24 小時一條水平時間軸，綠色是有在觀測，灰或紅是缺口，附覆蓋率百分比。這是整個系統最重要的一張圖：它直接告訴操作人「哪些時段的『沒事』其實是『不知道』」。
4. **資料來源**：依供應商分組，問題排最前面；提供「只看異常」篩選；顯示錯誤類別（`OKX_CODE_50113`）與額度桶；退避中的項目顯示「4 分後重試」。
5. **額度**：自繪進度條，標出警告線、硬性上限與供應商上限，顏色與狀態一致；依本月燃燒率推估「預計在 10/27 達到硬性上限」。
6. **窄螢幕**：640 px 以下把表格改成卡片清單，狀態徽章放在每張卡片的第一行。
7. **細節**：地址與 mint 用等寬字、縮寫成 `So11…1112`，附複製鈕；載入時用 skeleton，不用「讀取中…」；數值更新時淡淡地閃一下底色（尊重 `prefers-reduced-motion`）；表格加 `<caption>`，焦點樣式清楚。
8. **導覽**：等第一個真正的頁面（市場快照或證據）出現時，再加分頁（系統／市場快照／證據／Paper／研究）。不要先做空的分頁。

## 7. 策略面：直言

**原則**：在不確定性最高的地方先取得資訊。資訊價值最高的那一步，應該最先做。

**邏輯**：整個 M2 設計建立在一個未驗證的假設上：「OKX Premium 端點（memepump、holder、cluster）在免費方案可用」。如果 probe 回 `PAYMENT_REQUIRED`，discovery 與 cohort 的設計就要改。這個答案只要申請三組免費憑證、跑一次 `npm run probe` 就能取得。

**例證**：

- 2026-10-05：M0 完成，阻礙縮減到「憑證」一項。
- 2026-10-06：PR #4（OKX envelope），憑證仍未到位。
- PR #5：DEX Screener parser＋migration 0002，不在任務看板上，合併後也沒有更新任何狀態文件。
- 2026-10-13：憑證仍未到位。

每一個 PR 本身都做得好，但它們都是「不需要面對真實資料」的工作。這是典型的迴避型模式：繼續打磨可控的基礎設施，延後那個可能推翻設計的測試。風險不在程式碼，而在於系統累積了很多精緻的管線，卻還沒有產出任何一個可以被證偽的研究結論。

**行動**：

1. 下一個工作階段的第一件事：申請 Jupiter、Helius、OKX 的免費唯讀憑證，跑 `npm run probe`。這比本文件列的任何修正都重要。
2. 同時，本文件的 P0 修正（`RV-01`～`RV-05`）不需要憑證，可以平行進行，**但不應該成為繼續延後憑證的理由**。
3. 為 M1 設一個日期，例如 2026-10-27。到期時以「是否產出第一筆有證據的 CONTROL_PAPER round-trip」驗收，不以程式行數或測試數衡量。

## 8. 功能建議

只列 M0–M4 授權範圍內、不新增費用的項目。大多數是藍圖已有、但沒有拆成任務的部分。

| ID | 功能 | 為什麼現在值得做 | 對應 |
|---|---|---|---|
| FT-01 | 證據瀏覽器：`GET /api/events?subject=…`、raw observation 的中繼資料與本文、quarantine 清單 | Parser 已經在產生事件，卻沒有任何方式看到它們。E4.1「每項判斷可追到 evidence」的前提 | E4.1 |
| FT-02 | 市場快照頁：每個 pair 的最新 snapshot，`UNKNOWN` 的原因明確顯示（例如「單位未確認」），不畫成 0 或空白 | 第一個真正用到 parser 輸出的畫面，也能驗證 UI 對 `Observed<T>` 的呈現 | M1 |
| FT-03 | 排程器：slot 化的 dedupe key；停機後不補發所有錯過的 slot，只跑最新的一個，錯過的部分記成缺口 | 藍圖的固定排程目前完全沒有實作 | M2 前置 |
| FT-04 | `morrow reparse --parser <version>`：parser 升版後重新解析既有證據 | Quarantine 的價值在於「之後能用確認過的規則重讀」，目前沒有重讀的工具 | M1 |
| FT-05 | `morrow doctor`：檢查工具鏈、資料庫、migration、憑證是否存在（不顯示值）、各主機能否連線、時鐘偏移 | 把 operations.md 的疑難排解表變成一個指令；同時補上 D6 | M1 |
| FT-06 | 備份與還原提前：`pg_dump` 到資料目錄之外，並定期還原到獨立的測試資料庫 | 目前 `pgdata` 是唯一的一份。成本很低，一旦遺失就無法挽回 | E4.2 提前 |
| FT-07 | `morrow status` 顯示各資料表大小與每日成長 | D5 的量測工具；先量測，再決定保留期限 | M2 前置 |
| FT-08 | 決策日誌：每份 thesis 必須寫下機率、到期日、「什麼會證明我錯了」；到期自動產生 label，累積 Brier score | 校準要從第一筆決策開始累積，事後補不回來。這是對抗後見之明偏誤的唯一可靠方法 | E3.1 設計要求 |

## 9. 流程與文件

| 問題 | 建議 |
|---|---|
| PR #5 不在任務看板上（AGENTS.md §8：不在 Next／In Progress 的任務不得開始），合併後也沒有更新 tasks.md、PROJECT_STATUS、architecture、contracts | 本次已補記；新增 PR 範本，把「更新看板與狀態文件」列為勾選項（RV-10） |
| 藍圖 §5 規定 agent「不得自行 push、PR 或 merge」，實際上已經 push 並開 PR；本次操作人明確要求開 PR 並合併 | 已記入 PROJECT_STATUS「與藍圖的差異」 |
| 沒有 linter／formatter（例如 `const state =used`、`Logger =createLogger` 的格式） | 加入 Biome（單一 dev 相依、不需 install script）（RV-11） |
| 輔助腳本只有 PowerShell 版 | 個人使用沒有問題；CI 需要 bash 的等價步驟，隨 RV-05 處理 |

## 10. 建議順序

1. **操作人**：申請憑證 → `npm run probe` → 結果寫進 PROJECT_STATUS（E1.0 收尾）。
2. **P0**（不需要憑證，可以平行）：RV-01 health 新鮮度 → RV-02 parser 防毒 → RV-03 來源狀態語意 → RV-04 DB 逾時 → RV-05 CI。
3. **UI 第一批**：UI-01（新鮮度與相對時間）、UI-02（狀態列與四級狀態）、UI-03（表格溢出）。都依賴 RV-01／RV-03 的 API 欄位。
4. **M2 之前**：RV-08 provider 層級退避、RV-12 兩條隊伍、RV-13 儲存策略、FT-03 排程器、FT-06 備份。
5. 之後依藍圖進行 E1.1、E1.2。
