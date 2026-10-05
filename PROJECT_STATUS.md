# Project status

目前階段、驗證證據、阻礙與下一步。這是唯一的狀態文件；里程碑定義在 [ROADMAP.md](ROADMAP.md)，任務在 [tasks.md](tasks.md)。

最後更新：2026-10-05

## 現況

- **M0（基礎與契約）完成。** 五項完成門檻中四項達成；第五項「保存 provider entitlement probes」的機制完成且結果已保存，但除了不需要金鑰的 DEX Screener，還沒有取得任何供應商的實際權限資料。
- **E1.0 進行中。** 13 個功能的端點都已對照官方文件核對並補齊，OKX 各端點也已依官方價目頁分到 Basic 或 Premium 額度桶。在目前的開發機上實際跑 probe：DEX Screener 回 200，其餘 12 個因為沒有憑證而沒有送出。
- **M1 受阻**，現在只剩憑證。網路問題在目前的開發機上不存在。見「阻礙」。
- 系統只有 probe 會取得市場資料，沒有任何資料解析或交易功能，Paper 的也沒有。

## M0 交付內容

| 項目 | 內容 |
|---|---|
| 專案骨架 | npm workspaces：`packages/core`、`apps/runtime`、`apps/web`。TypeScript 7、Node 24、lockfile、禁止相依套件執行 install script |
| 契約 | 資產識別、`Observed<T>`、時間語意、provenance、canonical event、運作模式、健康報告 |
| 資料庫 | Migration 執行器與 `0001_foundation`：12 張資料表，其中 7 張 append-only |
| 原始證據 | 內容定址的回應本文；每個送出的請求一筆紀錄，不論成敗 |
| Jobs | PostgreSQL 佇列（transactional outbox、at-least-once、租約、重試、dead letter）與 consumer 去重 |
| 執行階段 | 啟動、心跳、乾淨停止、異常中止偵測、三種觀測缺口 |
| 額度帳本 | 原子性的預留、警告線、本地硬性上限、每次嘗試的紀錄 |
| 供應商層 | 4 個供應商定義、13 個功能、唯一的 HTTP 客戶端、來源健康狀態、節流、probe |
| 設定 | 嚴格的環境變數驗證；任何實盤模式在啟動時被拒絕；secret redaction |
| API 與 dashboard | 只綁 loopback 的 `GET /api/health`；顯示健康狀態的 dashboard |
| 工具 | 免管理員權限的工具鏈安裝與本機 PostgreSQL 管理腳本 |

## 驗證證據

執行環境：Windows 11、Node 24.19.0、PostgreSQL 17.11、2026-10-05。

### Build

| 檢查 | 結果 |
|---|---|
| `npm run typecheck`（core、runtime、web） | 通過 |
| `npm run build`（`tsc -b` 與 `vite build`） | 通過 |
| 全新 clone 後 `npm ci`、`npm run build`、`npm run test:unit` | 通過（見 PR 說明） |

### Automated

`npm test`：**150 個測試全部通過**，其中 68 個不需要資料庫，82 個對真實的 PostgreSQL 17 執行。每個資料庫測試檔使用自己的 schema，結束後刪除。（M0 交付時為 148 個；E1.0 新增 2 個，見下方「其他涵蓋」。）

| M0 門檻／story 的完成測試 | 對應的測試 |
|---|---|
| 空資料庫可 migrate | `migrate.dbtest`：空庫套用、重跑為 no-op、並行執行、失敗完整回滾、已套用檔案被修改會被偵測、資料庫比程式新會被拒絕 |
| 啟停成功 | `processes.dbtest`：API 與 worker 啟動、服務、乾淨停止、連接埠釋放；經資料庫要求停止；未 migrate 時拒絕啟動 |
| Secret redaction | `redact.test`、`jobs.dbtest`、`client.dbtest`：日誌、job 的錯誤訊息、原始證據表中都找不到憑證 |
| 任何 live mode 啟動均拒絕 | `cli.test`：5 個實盤模式 × `api`／`worker` 實際啟動 CLI，全部 exit 2 且沒有連線資料庫；其他指令亦同 |
| Transaction 回滾不留下孤兒 job（E0.2） | `jobs.dbtest`：回滾後 job 與證據都不存在；提交則兩者同時存在 |
| 重送冪等（E0.2） | `jobs.dbtest`、`foundation.dbtest`：重複 enqueue、重複事件、重送的 job 不重複產生效果 |
| 429／402 正確降級（E0.3） | `client.dbtest`、`providers.test`：429 依 Retry-After 暫停且任何理由都不能插隊；402 保存回應、不重試、只有 probe 可重測 |
| Quota 正確降級（E0.3） | `quota.dbtest`、`client.dbtest`：警告、硬性上限、60 個並行預留不超額、到上限後請求不送出 |
| Raw unit ambiguity 正確降級（E0.3） | `decimal.test`：未確認單位的比例為 `UNKNOWN`，不猜測；placeholder 不是 0 |

其他涵蓋：append-only 表拒絕 UPDATE／DELETE／TRUNCATE、租約過期後重新派發、執行階段的各種接手與衝突情境、API 的 Host／Origin 檢查與只綁 loopback、redirect 不跟隨、回應過大、逾時。

E1.0 新增（`providers.test`）：沒有任何功能的請求帶 `taker`、呼叫 execute／broadcast／send／sign／build 類路徑，或在 body 送出交易；OKX 7 個功能的額度桶與官方價目頁一致。

對供應商的測試使用本機的假 HTTP 伺服器。依藍圖，這屬於自動化測試證據，不是 live 證據。

### Runtime（真實行程，本機）

| 步驟 | 結果 |
|---|---|
| 對空的 `morrow` 資料庫執行 `npm run migrate` | 套用 `0001_foundation`；再執行一次回報已是最新 |
| `MORROW_MODE=LIVE_CANARY npm run api`、`MORROW_MODE=FULL_AUTO npm run worker` | 都被拒絕，exit 2 |
| 以 `RESEARCH` 啟動 API 與 worker | 兩者 `RUNNING`；API 只在 `127.0.0.1:8787` 監聽；`/api/health` 回 200 |
| `npm run probe` | 完整走過 CLI → job → worker → 客戶端 → 存證；13 筆結果寫入 `provider_probes` |
| `npm run stop` | 兩個程序 exit 0，執行階段為 `STOPPED`，連接埠釋放 |
| 強制結束 worker 後重啟 | 新的 worker 立即接手；記錄 `UNCLEAN_SHUTDOWN` 缺口，以及先前乾淨停止造成的 `OFFLINE` 缺口 |
| 停掉 PostgreSQL 後執行 `npm run status` | 回報 `database unreachable (ECONNREFUSED)`，不會假裝正常 |

### Live data

**第一次 probe（M0，原開發網路）：沒有取得任何 live 資料。**

| 結果 | 數量 | 功能 |
|---|---|---|
| `TLS_UNTRUSTED` | 1 | `dexscreener/market.tokens`：唯一實際送出的請求。Node 拒絕了對方的憑證（`SELF_SIGNED_CERT_IN_CHAIN`），來源被標為 `DOWN` |
| `CREDENTIAL_MISSING` | 4 | Jupiter 3 個、Helius 1 個：沒有金鑰，請求未送出 |
| `ENDPOINT_UNVERIFIED` | 8 | OKX 7 個、Jupiter quote：端點尚未定義，請求未送出 |

這證明了降級行為在真實情況下如設計運作，但沒有回答「免費方案實際給了什麼」。

**第二次 probe（E1.0，目前的開發機，2026-10-05 13:53 UTC）：取得第一筆 live 資料。** 端點核對完成後，以 `RESEARCH` 模式啟動 worker 執行 `npm run probe`（job 1）：

| 結果 | 數量 | 功能 |
|---|---|---|
| `OK`（HTTP 200） | 1 | `dexscreener/market.tokens`：113 ms，1,406 bytes 的 JSON 陣列，存於 `raw_observations` #1 |
| `CREDENTIAL_MISSING` | 12 | Jupiter 4 個、OKX 7 個、Helius 1 個：沒有金鑰，請求未送出，也沒有扣額度 |

13 筆 `provider_probes` 都是 `doc_verified = true`，沒有 `ENDPOINT_UNVERIFIED`、`TLS_UNTRUSTED`。Worker 之後以 `npm run stop` 乾淨停止。

DEX Screener 回應的內容：wrapped SOL 只回了 1 個 pair（Orca 的 SOL/USDC，priceUsd 120.78，liquidity.usd 約 3,066 萬）。wrapped SOL 實際上有大量 pool，所以 `tokens/v1` 不能當成「這個 token 的所有 pool」，M1 寫 parser 時要考慮；要列出 pool 應改用 `token-pairs/v1`。

### Manual／UI

以無頭瀏覽器對執行中的 API 截圖檢查 dashboard：Paper-only 橫幅、整體狀態、資料庫、兩個程序、5 筆資料來源狀態、3 個額度桶、工作佇列都正確顯示，時間為台北時間。沒有做互動測試，也沒有檢查深色模式與窄螢幕。

### 尚未驗證

- 除 DEX Screener 以外，任何供應商的真實回應格式、實際額度與 rate limit。
- [registry.ts](apps/runtime/src/providers/registry.ts) 的端點已在 2026-10-05 對照官方文件核對（`docVerified: true`，每筆的 `note` 記錄了依據的文件網址）。OKX 的路徑與參數名稱另外對照了 OKX 官方 CLI 原始碼（`okx/onchainos-skills`，commit `9de8161`）。但除了 DEX Screener，還沒有一個端點收到真實回應，文件與實際行為可能不一致。
- OKX 簽章對真實 API 是否有效。測試只確認它與 OpenSSL 獨立算出的 HMAC 一致；簽章規則（ISO 時間 + method + 含 query 的 path + body，HMAC-SHA256、Base64）與官方文件一致。
- OKX 回應外層有自己的 `code` 欄位。目前的 probe 只看 HTTP 狀態碼，所以如果 OKX 用 HTTP 200 加上非 `"0"` 的 `code` 回報錯誤，probe 會記成 `OK`。有了 OKX 憑證跑 probe 時，要打開原始回應確認 `code`。
- 長時間執行（藍圖要求的三次 60 分鐘 session 屬於 M4）。
- 休眠後恢復的 `HEARTBEAT_STALL`：只以測試中調整心跳時間的方式驗證，沒有讓機器實際休眠。

## 阻礙

### 1. 網路封鎖了所有主要資料來源（目前的開發機已解決）

**2026-10-05 更新**：專案已移到另一台開發機。在這台機器上，DEX Screener、Jupiter、OKX Web3、Helius、Solana 公開 RPC、Telegram 與各家文件網站都能正常建立 TLS 連線，DEX Screener 的 probe 也實際回了 200。原網路的限制沒有改變，所以 live 驗收要在目前這台機器上做。以下是原網路的紀錄。

開發時使用的網路攔截或封鎖 DEX Screener、Jupiter、OKX Web3、Solana 公開 RPC、Telegram，以及這些供應商的文件網站。Helius、npm、GitHub 不受影響。觀察到的細節在 [docs/operations.md](docs/operations.md) 的「網路」一節。

這是該網路刻意的存取管制，本專案不會繞過。影響：

- M1–M4 的 live 驗收在這個網路上無法進行。
- 連供應商文件都讀不到，所以無法核對 API 的回應格式，也就不應該先寫 parser。

藍圖假設開發機可以直接連到這些供應商，這個假設在目前的環境不成立。依任務指示，M1 以後的實作在此停止，沒有另行改設計。

**需要操作人決定**：之後在哪個網路或哪台機器上執行。Repo 本身可以直接搬過去，M0 的程式與測試不需要修改。

### 2. 沒有供應商憑證

需要 Jupiter、Helius、OKX 的免費唯讀 API 金鑰；M3 另需 Telegram Bot token 與 chat ID。申請帳號是人工步驟。

### 3. MINDS 歷史成員名單

藍圖已註明：沒有歷史 107 個成員的名單，精確的歷史重建維持 `BLOCKED_MISSING_BASELINE_MEMBERS`。不阻擋 MVP。

## 與藍圖的差異

| 項目 | 藍圖 | 實際 | 原因 |
|---|---|---|---|
| Task 檔 | 建立 `TASKS.md` | 使用既有的 `tasks.md` | 操作人於 2026-10-05 決定；AGENTS.md §8 也指定 `tasks.md`。兩個檔名在 Windows 上是同一個檔案 |
| Git 流程 | Agent 只建立本機 commit，不 push、不開 PR | Commit、push、開中文 PR，不 merge | 操作人於 2026-10-05 對本次任務的指示 |
| AGENTS.md | 調查時不存在 | 已存在，並已填入 §0 | 藍圖完成後才加入 |
| Node 與 PostgreSQL 的安裝 | 列為人工前提 | 由 `scripts/setup-toolchain.ps1` 安裝到使用者目錄 | 機器上沒有，也沒有管理員權限；不安裝就無法建置或測試 |
| PostgreSQL 連接埠 | 未指定 | `54317` | 避免與日後可能安裝的其他 PostgreSQL 衝突 |
| M0 的契約範圍 | 「contracts」 | 只定義 M0 用到的部分，其餘隨各里程碑加入 | 避免寫出沒有程式使用、沒有測試驗證的 schema。清單見 [docs/contracts.md](docs/contracts.md) |
| Helius 額度門檻 | 只給了供應商上限 | 警告 70 萬、硬性上限 85 萬 | 沿用藍圖為 OKX 訂的比例，待量測後調整 |
| 計費週期 | 未指定 | UTC 曆月 | 假設，待對照帳戶後台 |
| 資料庫角色分離 | 威脅模型的控制措施之一 | 未實作；append-only 由 trigger 強制 | 已列入 Backlog |
| 停止程序 | 未指定 | 另外提供經資料庫的停止請求（`npm run stop`） | Windows 沒有可用的 SIGTERM，否則背景程序每次停止都會被記成異常中止 |
| Probe 的執行位置 | 未指定 | 由 worker 執行，CLI 只負責排入佇列並等待 | 維持「只有 worker 呼叫供應商」，節流器才有權威性 |
| OKX 端點與額度桶 | 列出所需功能 | 7 個功能都已定義端點（E1.0）。hot-token、trades 用 Basic；memepump、holder、cluster overview／list／top-holders 用 Premium | 依官方價目頁 [market-api-fee](https://web3.okx.com/onchainos/dev-docs/market/market-api-fee)。M0 時文件讀不到，所以當時沒有定義 |
| Jupiter quote | 「Jupiter」quote | Swap V2 的 `GET /swap/v2/order`，不帶 `taker` | `/swap/v1/quote` 已被官方標為不再維護。不帶 `taker` 時只回 quote，`transaction` 為 null；帶了 Jupiter 就會組出待簽交易，所以永遠不帶，並有測試把關 |
| Probe 使用的 token | 未指定 | wrapped SOL（Jupiter quote 另用 USDC 當輸出） | 永久存在、每個端點都認得。只用來確認權限，不代表研究標的 |

沒有降低任何驗收標準。無法取得的 live 證據維持 pending。

## 下一步

1. 操作人申請 Jupiter、Helius、OKX 的免費唯讀憑證並寫入 `.env`（阻礙 2）。
2. **E1.0 收尾**：在目前的開發機重跑 `npm run probe`，把 12 個功能的實測結果記在這裡；OKX 要同時檢查原始回應的 `code`。每個功能都是 `OK`，或有明確結論的 `PAYMENT_REQUIRED`／`UNAUTHORIZED`，E1.0 才算完成。
3. 之後才開始 E1.1 與 E1.2。

## 交接備註

- 新增供應商功能：在 [registry.ts](apps/runtime/src/providers/registry.ts) 加一筆 `CapabilityDefinition`。計量供應商必須指定 `quotaBucket`，而且該額度桶要有對應的 policy。對照官方文件後才設 `docVerified: true`，並在 `note` 寫下依據的網址與日期；OKX 的額度桶以官方價目頁為準。
- 單位不一致是已知的：OKX holder 的 `holdPercent` 與 cluster overview 的百分比是 0–100，cluster list／top-holders 的 `holdingPercent` 是 0–1 的比例。Parser 不可混用。
- 所有對供應商的請求都必須經過 `ProviderClient.request()`，不要直接呼叫 `fetch`。
- 新的 job handler 在 [processes.ts](apps/runtime/src/app/processes.ts) 的 `defaultHandlers` 註冊。Handler 必須能安全地重複執行；用 `markProcessed` 在同一個 transaction 內去重。
- 已套用的 migration 不可修改，只能新增。
- 測試不可連到真實的供應商。資料庫測試需要 `MORROW_TEST_DATABASE_URL`，且資料庫名稱必須以 `_test` 結尾。
