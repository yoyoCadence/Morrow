# Tasks

Use this file as the lightweight task board for this project unless the project explicitly uses GitHub Issues, Linear, Notion, or another tracker.

Task IDs (E0.1, E1.1, ...) come from [docs/plans/active-plan.md](docs/plans/active-plan.md) §4. Milestone gates are in [ROADMAP.md](ROADMAP.md); evidence for completed work is in [PROJECT_STATUS.md](PROJECT_STATUS.md).

`RV-`（修正）、`UI-`（介面）、`FT-`（功能）開頭的項目來自 [2026-10-13 專案審查](docs/reviews/2026-10-13-project-review.md)。括號內的 R／D／U 編號對應審查文件中的問題與證據。

## Next

> M1 無法開始，直到下方「Blocked」的憑證由操作人提供，並完成 E1.0。
>
> **最優先的一步是申請憑證並跑 `npm run probe`**（審查 §7）。下方「審查修正」不需要憑證，可以平行進行，但不應該成為延後憑證的理由。

- [ ] **E1.1 MINDS evidence**（P0，需 E0.3、E1.0）— Case ingestion、cohort。完成測試：歷史與 current 不混用；缺 107 成員名單時不能標為完成。
- [ ] **E1.2 Control Paper round-trip**（P0，需 E0.2、E1.0）— Quote、risk、ledger。完成測試：真實 quote 證據；虛擬買賣守恆；沒有假 signature。

### 審查修正 — 不需要憑證，可以立即進行

依序執行。每一項是一個獨立的 PR，並在同一個 PR 內更新本檔與 PROJECT_STATUS。


### Blocked — needs the operator

- [x] 提供可以直接連到 DEX Screener、Jupiter、OKX Web3、Helius 的執行環境（M3 起還需要 Telegram）。原開發網路封鎖了這些主機，細節見 [docs/operations.md](docs/operations.md)。2026-10-05 起改用目前的開發機，全部可以連上。
- [ ] 申請 Jupiter、Helius、OKX 的免費唯讀 API 憑證，寫入 `.env`。
- [ ] M3 之前：建立 Telegram Bot，取得 token 與 chat ID，並先對 Bot 送出一則訊息。
- [ ] 選擇性：提供 MINDS 歷史 107 個成員的名單與當時的證據。只影響 E1.1 的精確歷史重建，不阻擋 MVP。

## In Progress

- [ ] **E1.0 核對供應商端點並取得實際權限資料**（M0 追加，M1 的前置）
  - [x] 對照官方文件確認 `apps/runtime/src/providers/registry.ts` 內每個端點，補上 8 個尚未定義的端點，並標明 OKX 各端點屬於 Basic 或 Premium 額度。（2026-10-05）
  - [x] OKX 以 HTTP 200 回傳錯誤 `code` 時，依代碼分類，不再記成 `OK`（`okx-envelope.ts`）。（2026-10-06）
  - [ ] 設定憑證後在可連線的網路執行 `npm run probe`，把各功能的實測結果寫進 PROJECT_STATUS.md。2026-10-05 已在目前的開發機跑過一次：DEX Screener `OK`，其餘 12 個 `CREDENTIAL_MISSING`，等憑證。第一次要打開 OKX 與 Helius 的原始回應，確認錯誤格式與文件一致。
  - 完成條件：每個功能的結果是 `OK`，或是有明確結論的 `PAYMENT_REQUIRED`／`UNAUTHORIZED`；沒有 `ENDPOINT_UNVERIFIED`、`TLS_UNTRUSTED`。

## Backlog

### M2 — Discovery＋cohort

- [ ] **E2.1 Active discovery**（P0，需 E1）— Discovery、ranking。完成測試：不靠手動 watchlist 發現 mint；容量限制與對照樣本。
- [ ] **E2.2 Entity inventory**（P0，需 E2.1）— Graph projection、decoders。完成測試：split／merge／custody／unknown outflow 情境。

### M3 — Underwriting＋組合決策

- [ ] **E3.1 AI import**（P0，需 E2）— Research、thesis。完成測試：過期、機率不合、錯引用、注入內容都不產生 intent。
- [ ] **E3.2 Portfolio policy**（P0，需 E3.1）— Strategy、risk。完成測試：並行 reservation、cooldown、loss halt、unknown gates。
- [ ] **E3.3 Alerts**（P1，需 E3.2）— Notifier。完成測試：去重、節流、失敗重試、單一 chat allowlist。

### M4 — 驗證與 MVP 交付

- [ ] **E4.1 Dashboard 與 replay**（P0，需 E3）— UI、evaluation。完成測試：每項重要判斷可追到 evidence；固定輸入重播一致。
- [ ] **E4.2 Recovery 與交接**（P0，需 E4.1）— Operations、docs。完成測試：DB restore、休眠 gap、斷網恢復、驗收報告。

### M0 期間發現的後續項目

- [ ] 資料庫角色分離：migration 用 owner 角色，執行期用權限較小的角色（藍圖威脅模型的「分角色 DB 權限」）。目前 append-only 由 trigger 強制，但 migration 與執行期共用同一個角色。
- [ ] 對照各供應商的帳戶後台，確認額度的計費週期何時重置。目前假設是 UTC 曆月。
- [ ] 量測 Helius 各端點實際扣的 credits，據以調整警告線與硬性上限。目前沿用 OKX 的 70%／85% 比例。
- [ ] Helius JSON-RPC 錯誤碼的供應商語意：目前依 JSON-RPC 2.0 的代碼範圍分類（`-32000`～`-32099` 一律 `SERVER_ERROR`）。第一次以憑證 probe 後，對照原始回應與 Helius 文件確認 `-32005` 等代碼（Solana 的文件為節點落後，Helius 的 API schema 為請求過多）；若 Helius 以 HTTP 200 回報限流，把該代碼改為 `RATE_LIMITED`，才會套用限流的退避。
- [ ] 決定多個來源回報同一事件時，如何保存各自的佐證。矛盾的部分已由 RV-06 記錄在 `event_conflicts`；說的是同一個事實的第二筆仍然只是 no-op，各自的佐證沒有保存。
- [ ] 自動定期備份：`npm run backup`（FT-06）目前要手動執行。用 Windows 工作排程器，或在 worker 加一個本機排程；要決定頻率與保留幾份。
- [ ] 從備份還原成正式資料庫的指令與演練（E4.2）。FT-06 只做「還原到檢查用資料庫並核對」，正式還原的步驟目前寫在 docs/operations.md。
- [ ] 排程缺口的呈現：第一個真正的排程加入時，health 與觀測覆蓋要顯示 `schedule_gaps`（FT-03 目前只記錄）。
- [ ] 市場頁的「過時」門檻目前固定 5 分鐘（`apps/web/src/market.ts` 的 `SNAPSHOT_STALE_MS`，只是顯示規則）。第一個 `market.tokens` 排程加入時，改由排程間隔推導，並讓 API 回報所依據的間隔。
- [ ] 市場頁列出所有曾有 snapshot 的池子，包括已經不在追蹤清單、很久沒更新的池子。有排程之後加「只看最近 N 小時」的篩選，或把過時的池子收合在最後。
- [ ] 儀表板的 bundle 帶進了 core 的 `node:crypto`（`contracts/event.js` 的 fact hash；Vite 建置時警告 externalized）。目前瀏覽器不會呼叫到，但哪天呼叫就會在執行期失敗。把需要 Node 的部分移出儀表板會 import 的入口，或讓 web 只 import 它用到的契約。

### 審查發現 — M2 之前完成

- [ ] **RV-11b 一次性全域格式化**（P2；**需操作人決定**）— 以 `biome.json` 的設定執行 `npm run format`，之後在 CI 強制 `biome format`。實測會改寫 31 個檔案、約 +605／−228 行（行寬 120–160 都在 30 個檔案以上），所以 AGENTS.md §2 規定要先取得同意。做的話應該是一個只含格式化的 PR，並把該 commit 加入 `.git-blame-ignore-revs`。
- [ ] **RV-13 儲存策略**（P1；D4、D5；**需操作人決定**）— 先量測（FT-07），再決定：quarantine 是否改為每個 observation 一筆彙總、或只記錄新出現的原因；raw payload 與事件的保留期限；`jobs`、`consumer_inbox` 的清理。決策寫成 ADR。完成測試：依決策的保留規則不會刪到 replay 需要的證據。進度：量測與提案已完成，見 [ADR-0001](docs/adr/0001-storage-retention.md)。實測每個 pair 快照約 4.8 KB，其中一半是可完全重建的 quarantine。等待操作人回答 ADR 的 4 個問題（磁碟預算、每天運作時數、是否採用 Q2、是否採用 J1），之後依決策實作（ADR 的「決定之後的實作」）。

### UI 改善

依賴 RV-01／RV-03 提供的欄位。設計原則：這是操作工具，不是交易終端；視覺先回答「能不能相信這個畫面」，不做會誘發追高的動態效果（審查 §6）。


### 功能建議

都在 M0–M4 授權範圍內，不新增費用。

- [ ] **FT-08 決策日誌**（E3.1 的設計要求）— 每份 thesis 必須有機率、到期日、「什麼會證明我錯了」；到期自動產生 label，累積 Brier score。

### Not authorized

M5–M8（production readiness、live canary、guarded autonomy、learning）只在 [ROADMAP.md](ROADMAP.md) 中規劃，尚未授權，不得開始。

## Done

- [x] Define initial project goal and success criteria — 見藍圖與 AGENTS.md §0（2026-10-05）
- [x] Confirm tech stack and architecture constraints — 見藍圖與 AGENTS.md §0（2026-10-05）
- [x] Set up first runnable version — 即 M0（2026-10-05）
- [x] **E0.1 專案骨架與單一文件真相** — Runtime、core、web、canonical docs。新環境可 build；只有一份 Task 檔（本檔）。（2026-10-05）
- [x] **E0.2 Event／DB／jobs** — Persistence、contracts。Transaction 回滾不留下孤兒 job；重送冪等。（2026-10-05）
- [x] **E0.3 Provider capability／budget** — Adapters、source health。429／402、quota、raw unit ambiguity 都正確降級。實際權限資料待 E1.0。（2026-10-05）
- [x] `dev-env.ps1` 檢查 Node 版本：PATH 上的 Node 不符 `engines` 時改用 toolchain 的 Node，不需要升級其他專案共用的系統 Node。（2026-10-05）
- [x] DEX Screener `tokens/v1` parser（`dexscreener-tokens@1`）與 `PairSnapshot` 契約：數字保留來源的完整位數，單位未確認的欄位進 quarantine。（PR #5，事後補記於 2026-10-13：合併時沒有列在看板上）
- [x] 欄位層級 quarantine 的持久化：migration `0002_parse_quarantine`，隨第一個 parser 加入。（PR #5）
- [x] 專案審查：架構、測試、UI、功能建議，結論見 [docs/reviews/2026-10-13-project-review.md](docs/reviews/2026-10-13-project-review.md)；可派工的項目已列入上方 `RV-`／`UI-`／`FT-`。（2026-10-13）
- [x] **RV-01 Health 的新鮮度語意**（P0；R1、R2）— 心跳超過 `LIVENESS_THRESHOLD_MS` 的 `RUNNING` session 在 health 中標為過期（推導出來的狀態，不改寫 `run_sessions`）；`RESEARCH`／`PAPER` 模式下沒有新鮮的 worker 時，整體狀態不可為 `ok`。完成測試：心跳 10 分鐘前的 worker 使 health 降級並標出該 session；從未啟動 worker 時不是 `ok`；正常心跳不受影響。實作：`SessionView.liveness`（`LIVE`／`STALE`／`ENDED`，以資料庫時鐘計算）；`npm run stop` 對已沒有心跳的程序直接回報「not running」，不再等 30 秒；dashboard 顯示「心跳中斷」。（2026-10-13）
- [x] **RV-02 Parser 單筆隔離**（P0；R3）— 單一 pair 不符合 `PairSnapshot` 時，該 pair 以 `SCHEMA_REJECTED` 進 quarantine，同一回應的其他 pair 照常產生事件；必然失敗的解析錯誤不重試 5 次。完成測試：`priceUsd` 為 `1e-120`、`1e+100`、97 位數的回應，正常的 pair 仍有事件；job 不進 `dead`。實作：契約無法表示的數值在欄位層級成為 `UNKNOWN (NOT_REPRESENTABLE)` 並保存原文；仍不符合契約的 pair 整筆以 `SCHEMA_REJECTED` 進 quarantine。原本整份失敗的輸入現在有輸出，parser 升版為 `dexscreener-tokens@2`。（2026-10-13）
- [x] **RV-03 來源狀態語意與四級整體狀態**（P0；R4、R8、D7）— **先以 Mode A 提出設計再實作**。`NOT_FOUND` 與 `CLIENT_ERROR`（包含 OKX envelope 錯誤）不可顯示為 `HEALTHY`；health 回應提供最近一次的 `error_class`；整體狀態分出「沒有憑證（需注意）」與「實際故障（異常／嚴重）」。若需要新的 `source_health.state`，以新的 migration 修改 CHECK。OKX `50101`／`50102` 的分類要等真實回應確認。完成測試：永遠回 404 的功能使整體狀態降級；只缺憑證時狀態與資料庫斷線不同。實作：新的來源狀態 `REQUEST_REJECTED`（migration `0003`，既有資料依新規則轉換）；`HealthReport` 改為四級狀態並列出 `findings`；來源檢視多了 `last_error_class`；連續 3 次被拒絕視為異常。設計記錄在 PR 說明。OKX `50101`／`50102` 仍待真實回應確認。（2026-10-13）
- [x] **RV-04 資料庫逾時**（P0；R5）— Pool 設定 `connectionTimeoutMillis`、`keepAlive`，執行期連線設定 `statement_timeout`（migration 例外）；心跳本身有逾時，不會因為一次卡住就永久停止。完成測試：連到不可達位址在設定時間內失敗；超時的查詢被中止；心跳卡住後能恢復。實作：連線 10 秒、語句 30 秒、等待回應 40 秒、閒置 transaction 60 秒、TCP keepalive；心跳 5 秒；`migrate` 不設語句上限；狀態不明的連線被銷毀而不回到 pool；CLI 與 health 能辨認連線逾時。（2026-10-13）
- [x] **RV-05 CI**（P0；需操作人同意使用 GitHub Actions 免費額度）— 每個 PR 跑 `npm ci`、typecheck、build、全部測試（PostgreSQL 17 service、Node 依 `.node-version`）。完成測試：故意弄壞一個測試時 CI 失敗；README 記錄 CI 與本機指令的對應。實作：`.github/workflows/ci.yml`（ubuntu-24.04、PostgreSQL 17、Node 依 `.node-version`，actions 以 commit 釘住）；同一個 PR 先以故意失敗的測試證明 CI 會失敗，再移除。操作人已於 2026-10-13 同意。（2026-10-13）
- [x] **RV-06 矛盾資料可見**（P1；R6）— 相同 `dedupe_key`、不同 payload 時，記錄衝突（獨立的 append-only 表或 audit），不再靜默丟棄。完成測試：相同內容重送仍是 no-op；不同內容留下可查詢的衝突紀錄。實作：`events.fact_sha256`（只涵蓋事實本身，不含 provenance 與 `observed_at`）與 append-only 的 `event_conflicts`（migration `0004`）；health 對近 24 小時的矛盾給出 `EVENT_CONFLICTS`（需注意）。0004 之前存的事件沒有 hash，比對時由已存的欄位推導，結果與寫入時計算的相同。（2026-10-13）
- [x] **RV-07 `confidence` 精度一致**（P1；R7）— 契約限制最多 6 位小數，與 `numeric(7,6)` 一致；目前沒有 producer，不需要轉換舊資料。完成測試：7 位小數在寫入前被拒絕。（2026-10-13）
- [x] **RV-08 Provider 層級退避**（P1；D1）— 帳號共用的限制（Jupiter、Helius 的 429）暫停整個供應商；方案或權限造成的錯誤仍以功能為單位。完成測試：一個 Jupiter 功能被 429 時，另一個 Jupiter 功能被 `SUPPRESSED`。實作：`ProviderDefinition.rateLimitScope`；共用限制記錄在 capability 為 `*` 的 `source_health` 列，只追蹤 rate limit，下一次成功就清除。OKX 的限流範圍尚未確認，先保守地視為整個供應商。（2026-10-13）
- [x] **RV-09 簽章時間與時鐘偏移**（P1；R9、D6）— OKX 在節流等待之後才簽章；記錄供應商回應 `Date` header 與本機時間的差，超過門檻時依藍圖 fail-safe 停止依賴新鮮度的工作。完成測試：等待期間時間前進時，簽章使用送出當下的時間；偏移超過門檻會反映在 health。實作：節流等待之後才以當下時間重新授權；`raw_observations.server_date` 與 `clock_offset_ms`（migration `0005`，以收到 header 的時間估計，不受 body 傳輸時間影響）；health 的 `clock.skew_ms` 為近期回應的中位數，樣本不足時為 null；超過 5 秒需注意、超過 30 秒異常。「停止依賴新鮮度的工作」要隨第一個這類工作加入，目前還沒有。（2026-10-13）
- [x] **RV-10 PR 範本與文件同步**（P1；審查 §9）— 新增 `.github/pull_request_template.md`：對應的任務 ID、是否更新 tasks.md／PROJECT_STATUS／架構文件、驗證指令輸出。（2026-10-13）
- [x] **RV-11 Lint 與 format**（P2）— 加入 Biome（單一 dev 相依），先只格式化，再逐步開規則；與 RV-05 一起在 CI 執行。實作：Biome 2.5.15（dev 相依，不需 install script）只作 linter，在 CI 執行；recommended 規則，關掉純風格的 `useLiteralKeys`（對不可信 JSON 刻意用方括號存取）與 `useTemplate`；修正 3 個實際問題。Formatter 已設定但不強制，因為全域格式化要先取得同意，見 RV-11b。（2026-10-13）
- [x] **RV-14 開發相依的弱點**（P2）— `source-map-js@1.2.1`（經 vite → postcss，只在建置時使用）升級到修正版，遵守 `.npmrc` 的 `min-release-age`。實作：只更新 lockfile，`source-map-js` 1.2.1 → 1.2.2（2026-09-30 發布，postcss 的 `^1.2.1` 範圍內）；`npm audit` 為 0。（2026-10-13）
- [x] **RV-15 API 請求日誌**（P2；U9）— Health 輪詢不要每次寫 2 行 info 日誌（開著分頁每天約 1.7 萬行）；錯誤與非 GET 請求照常記錄。實作：Fastify 的 `logController`（`apps/runtime/src/api/request-log.ts`）把每個請求改為完成時寫一行，含 method、url、host、狀態碼與回應時間；成功的 GET／HEAD 記 debug（預設看不到，`MORROW_LOG_LEVEL=debug` 才顯示），Host／Origin 被拒（403）記 warn，其他 4xx 與所有非讀取請求記 info，5xx 記 error。（2026-10-13）
- [x] **RV-12 Worker 的兩條隊伍與租約續租**（P1；D2、D3）— 同一個 worker 程序內分成「供應商請求」與「本機運算（parse 等）」兩個迴圈，節流器仍只有一份；長時間的 job 定期續租。完成測試：慢速供應商不會延遲 parse job；長 job 不會被重新派發。實作：worker 程序內 `local`（`raw.parse`，列在 `LOCAL_JOB_KINDS`）與 `network`（其他所有種類）兩個 `JobWorker` 迴圈，各自一次一個；沒有宣告為本機的種類一律走 `network`，避免新的供應商 job 意外與其他供應商請求並行。執行中的 job 每三分之一租約以 `renewLease` 續租，停止續租並等待進行中的續租完成之後才標記完成。續租同時修正了分成兩條隊伍才會出現的問題：最後一次嘗試的 job（例如 `maxAttempts: 1` 的 probe）超過租約時，另一條隊伍的輪詢會把仍在執行的 job 標記為 dead。Lease 遺失時目前只記錄，不會中斷 handler。（2026-10-13）
- [x] **FT-07 儲存量測**（P1，RV-13 的前置）— `morrow status` 顯示各資料表大小與每日成長。實作：改為獨立的 `npm run storage`（`apps/runtime/src/db/storage.ts`），沒有放進 `status`：`status` 與 `/api/health` 是同一份報告，儀表板每幾秒輪詢一次，而計算列數要掃描每一張表。列出每張表的列數、大小（含索引與 TOAST）、近 24 小時新增的列數與估計成長，以及 30 天推算；沒有時間欄位的表顯示 `?`（未知，不是 0）。每張表都必須登記在 `STORAGE_TIME_COLUMNS`，有測試檢查。另附 `scripts/measure-snapshot-storage.mjs` 量測每個 pair 快照的成本。（2026-10-13）
- [x] **UI-01 新鮮度與相對時間**（P1，需 RV-01；U1、U5）— 心跳、最近成功等改為「12 秒前」，完整時間放在 tooltip；過期 session 的紅色「心跳中斷」徽章已隨 RV-01 完成；頁首顯示「上次更新」與更新指示點。實作：`apps/web/src/time.ts`（`formatRelative`、`serverNow`、`freshness`，純函式，留給 UI-09 測試）；程序的啟動與最後心跳、來源的最近成功與暫停至都改為相對時間（`<time>`，tooltip 是完整的台北時間）。相對時間以報告本身的伺服器時間加上送出請求後經過的時間計算，不受瀏覽器時鐘影響，並每秒更新；從送出而不是收到起算，所以回應很慢（例如資料庫卡住）時只會顯示得比實際舊，不會比實際新（#22 的 Codex 審查意見，後續修正）。頁首右側的靜態圓點與「上次更新 N 秒前」：1.5 個輪詢週期內為綠、3 個以內為黃，之後或 API 無回應時為紅；API 無回應時顯示「無法更新 · 上次成功 N 前」，下方最後一次的報告變灰，表示它不是現在的狀態。依審查 §6 不做閃爍或動畫。觀測缺口仍顯示完整時間（它們是歷史區間，已有長度欄）。（2026-10-13）
- [x] **UI-02 頁首狀態列**（P1，需 RV-03；U4）— 四級整體狀態與對應顏色；小指標：worker 心跳、健康來源數、最高額度使用率、dead job 數；分頁標題與 favicon 隨狀態變化。實作：`StatusBar`（整體狀態以文字呈現，色調與左側實線只是重複；「N 個原因，見下方」）與 4 個小指標：worker 心跳（`LIVE` 顯示相對時間，`STALE` 為心跳中斷，未執行只在有 `WORKER_NOT_RUNNING` 時標紅）、來源「正常 N/M」（不計 `*` 列；共用限流未解除時標黃，並寫出是哪個供應商）、最接近硬性上限的額度桶百分比（無條件捨去）、失敗終止的工作數。報告無法讀過資料庫那一段時（`database.problem` 有值），這些欄位只是空的佔位，4 個指標一律顯示「未知」，不顯示「未執行」或「0」。純函式在 `apps/web/src/status.ts`，留給 UI-09 測試。分頁標題為「異常 · Morrow」這類格式，API 無回應時為「無法更新 · Morrow」（UI-07 起，沒有可用回應的三種情況都用這個標題）；favicon 是 `apps/web/public/` 下 5 個靜態 SVG，形狀也不同（勾、驚嘆號、八角形叉、空心圓），不只靠顏色。用靜態檔而不是 `data:` URL，因為 API 的 CSP 是 `default-src 'self'`。（2026-10-13）
- [x] **UI-03 資料來源表**（P1，需 RV-03；U2、U6）— 修正 1280 px 下的截斷；依供應商分組、問題排最前面、「只看異常」篩選；顯示錯誤類別與額度桶；退避中顯示剩餘時間。實作：依供應商分組，最嚴重的供應商排最前面，組內問題排前面（`apps/web/src/sources.ts`，純函式）；組標題寫出「N 個功能，M 個有問題」，`*` 列不算功能，共用限流另外寫成「整個供應商限流中」。「只看異常」隱藏 HEALTHY 的列並寫出隱藏了幾個，選擇記在 localStorage（被封鎖時只是不記住）。新增「額度桶」欄：契約的 `SourceHealthView.quota_bucket`（由 registry 的 `quotaBucketOf` 填入）加上本月用量百分比。錯誤類別已隨 RV-03 顯示；退避剩餘時間已隨 UI-01 以「41 秒後」顯示。1280 px 下不再出現橫向捲動：長的錯誤文字可以換行。（2026-10-13）
- [x] **UI-04 額度視覺**（P2；U7）— 自繪進度條標出警告線、硬性上限與供應商上限，顏色與狀態一致；依本月燃燒率推估達到硬性上限的日期。實作：SVG 進度條（不需要 inline style，符合 API 的 CSP），全長是供應商上限，刻度標出警告線與硬性上限，填色依 OK／WARN／HARD_STOP；契約新增 `QuotaView.source_limit`（來自 `QUOTA_POLICIES.sourceLimit`）。「依目前速度」欄（`apps/web/src/quota.ts`，純函式）以本月到目前的平均速度推估：本月內達到時寫出台北日期，否則寫出月底約為上限的幾 %；本月未滿一天不推估（幾小時的速度只代表一次突發）；已達上限、尚無用量各有說明。平均以日曆時間計算，關機時間也算在內，所以只是粗估。（2026-10-13）
- [x] **UI-05 觀測覆蓋帶**（P1）— 近 24 小時與 7 天的時間軸，標出觀測中與缺口，附覆蓋率百分比。需要 API 提供時間範圍內的 session 與 gap。實作：新增唯讀端點 `GET /api/coverage?hours=24|168` 與契約 `CoverageReport`；`api/coverage.ts` 的 `coverageSegments`（純函式）把 worker 的 session 與 `session_gaps` 換算成連續的區段，未觀測的每一段都有原因（`OFFLINE`、`UNCLEAN_SHUTDOWN`、`HEARTBEAT_STALL`、`HEARTBEAT_LOST`、`MODE_OFF`、`NO_RECORD`）；重新啟動時兩次讀取時鐘造成、短於 1 秒的縫隙併入前一段（資料庫測試先重現了這個縫隙）。儀表板以 SVG 畫近 24 小時與 7 天兩條，每段有 tooltip，寫出覆蓋率（無條件捨去）與各原因的總時間；每分鐘更新一次，與健康報告分開。（2026-10-13）
- [x] **UI-07 輪詢穩健性**（P1；U8）— 請求逾時與取消、不重疊、分頁在背景時暫停、以 `HealthReport` schema 驗證回應以發現契約漂移。實作：`apps/web/src/poll.ts`：`fetchChecked` 每個請求 15 秒逾時、元件卸載時取消，回應以共用契約的 zod schema（`HealthReport`、`CoverageReport`）驗證，不符時是錯誤而不是畫出來；`startPolling` 在上一次完成後才排下一次，所以不會重疊，分頁回到前景時立刻更新。與任務文字的差異：背景時**放慢**而不是暫停（健康 60 秒、覆蓋 5 分鐘），因為 UI-02 的分頁標題與 favicon 就是要在別的分頁時顯示狀態；瀏覽器本來也會把背景計時器限制到約每分鐘一次。契約不符時提示「儀表板與 API 不是同一個版本」，附上第一個不符的欄位，並說明要重新建置與重新啟動 API。先於 UI-06 處理：P1，且影響畫面能不能被相信。（2026-10-13）
- [x] **UI-06 窄螢幕版面**（P2；U3）— 640 px 以下表格改為卡片清單，狀態放在第一行。實作：只用 CSS，表格仍是同一份 markup：每個儲存格有 `data-label`，640 px 以下每列變成一張卡片，第一行是這一列在講什麼（`cell-primary`：元件、功能、供應商與額度桶）與狀態（`cell-status`），其餘是「標籤　值」。套用在程序、觀測缺口、資料來源、額度四張表；沒有內容的行（沒有退避、沒有月額度）在卡片裡省略，寬版仍顯示「—」。表頭在畫面上隱藏但留給螢幕閱讀器。Playwright 驗證 390、640、1280 px 下頁面與每張卡片都沒有橫向捲動，亮色與深色都截圖確認；1280 px 版面不變。（2026-10-14）
- [x] **UI-08 無障礙**（P2）— 表格 caption、清楚的焦點樣式、`prefers-reduced-motion`、狀態不只靠顏色表達。實作：先以瀏覽器的無障礙樹量測，再修正量到的問題：表頭原本被當成一般的 cell（補上 `scope="col"`，24 個 columnheader）；4 張表都有只給螢幕閱讀器的 caption；窄版卡片裡的標籤原本被讀進每一格（改用 `content: attr(data-label) / ""`）；窄版省略的空行原本從無障礙樹消失，每列的格數不一致（改為只在視覺上隱藏，1280 與 390 px 都是 127 格）；鍵盤焦點有清楚的外框（兩種主題都有 `--focus` 色）；覆蓋帶的「非預期中斷」加上斜紋，不只靠紅與綠區分，圖例同步。頁面沒有任何動畫或轉場，所以 `prefers-reduced-motion` 本來就符合；之後加入的動畫一律放在 `prefers-reduced-motion: no-preference` 裡。UI-06 擔心的「卡片版面失去表格語意」實測沒有發生（Chromium 保留了 table 角色）。（2026-10-14）
- [x] **UI-09 前端測試**（P2，需 RV-05）— 狀態判斷抽成純函式並以 `node:test` 測試；CI 加一個 Playwright 冒煙測試（亮色、深色、390 px）。實作：儀表板的純函式模組（`time`、`status`、`sources`、`quota`、`coverage`、`poll`）由 `apps/web/tsconfig.test.json` 編譯到 `apps/web/dist-test`，以 `node:test` 執行，納入 `npm test` 與 `npm run test:unit`，共 35 個測試；fixture 以共用契約的 schema 驗證，API 不可能送出的報告會直接失敗。為了讓 Node 能執行編譯結果，web 的相對 import 改為 `.js` 副檔名（Vite 照樣解析）。`fetchChecked` 對本機 HTTP 伺服器測試契約不符、非 JSON、HTTP 錯誤、逾時（包括 header 準時、本文卡住，#28 的回歸）、連線失敗與取消；`startPolling` 以假的頁面與 mock timers 測試不重疊、背景放慢、回到前景立即更新、停止後不再執行。把兩道防護同時拿掉時對應的測試會失敗（只拿掉一道時另一道仍擋住，行為不變）。冒煙測試 `apps/runtime/src/api/dashboard.e2e.ts`（`npm run test:e2e`）：真實的 API 伺服器、種好資料的測試資料庫、建置好的 dashboard，以 Playwright 1.63.0 的 Chromium 在亮色與深色、1280 與 390 px 檢查整體狀態、分頁標題與 favicon、各區塊、來源列的狀態與額度桶、頁面與卡片不橫向捲動、背景跟隨色彩配置，以及主控台沒有任何錯誤或警告（含 CSP 違規）、沒有失敗的請求。CI 在 `npm test` 之後安裝 Chromium（headless shell）並執行；本機可用 `MORROW_E2E_CHROMIUM` 指定已安裝的 Chromium 或 Chrome。測試找到兩個問題，同一個 PR 修正：(1) 額度百分比先除後乘，浮點誤差讓剛好 29%（85,000 的 24,650）顯示為 28%，改為先乘後除（`usedPercent`），覆蓋率同樣處理；(2) 自 UI-07 起，每次載入頁面瀏覽器都回報一個 CSP 違規：zod 4 用 `new Function` 試探能否編譯 parser，被 CSP 擋下後雖然有攔截，瀏覽器仍會回報。改為在任何 schema 建立之前設定 `jitless`（`apps/web/src/zod-config.ts`）。UI-07 驗證時的模擬伺服器沒有送 CSP header，所以當時沒有看到。（2026-10-14）
- [x] **FT-03 排程器**（P0，M2 的前置）— slot 化的 dedupe key（例如 `schedule:<名稱>:<slot>`）；停機後只跑最新的 slot，錯過的部分記成缺口，不一次補發。實作：`apps/runtime/src/jobs/scheduler.ts` 與 migration `0006`。Slot 對齊 UTC epoch，dedupe key 為 `schedule:<名稱>:<slot 開始的 ISO 時間>`，payload 帶 `schedule` 與 `slot_start`，預設不重試（下一個 slot 就是重試）；沒有 tick 到達資料庫的 slot（停機、休眠、`OFF`、資料庫連不上）只跑目前的一個，其餘記成一列 `NOT_SCHEDULED`；上一個 slot 的 job 還在排隊時跳過、不堆積，積壓結束時記成一列 `BACKLOG`；本機時鐘與供應商差超過 30 秒時暫停，記成 `CLOCK_SKEW`（藍圖 fail-safe；Codex 審查意見，偏移未知時不暫停，否則永遠量不到）。狀態在 `schedule_state`（可變投影），缺口在 append-only 的 `schedule_gaps`。Worker 只在 `RESEARCH`／`PAPER` 執行排程；排程的 job 種類沒有 handler 時拒絕啟動，且在記錄 session 之前。**目前沒有登記任何排程**：現有的 job 只有 parse 與 probe，藍圖的固定排程要隨各自的 handler（E1、E2）一起加入 `defaultSchedules`。（2026-10-14）
- [x] **FT-06 備份與還原提前**（P1）— `pg_dump` 到資料目錄之外，並還原到獨立的測試資料庫驗證；不得覆蓋使用中的資料庫。實作：`npm run backup`（`apps/runtime/src/db/backup.ts`）。傾印到 `MORROW_BACKUP_DIR`（必須是絕對路徑、在 repo 之外），manifest 記錄每張表的列數、trigger、migration、大小與 SHA-256；列數與傾印來自同一個 export 的 snapshot，執行中也一致。寫完立刻還原到 `<資料庫>_restore_check` 逐項核對，通過才在 manifest 記下 `restore_check`；目標名稱由程式推導且連線後再確認，不會碰使用中的資料庫。密碼以 `PGPASSWORD` 傳給工具，不在命令列；工具版本必須不舊於伺服器；檢查用資料庫不存在時在傾印之前就停止。`pg-local.ps1 init` 會建立 `morrow_restore_check` 與 `morrow_test_restore_check`（重跑 init 即可補上）；CI 從 PostgreSQL 官方 apt 套件庫安裝 17 版 client。原本 Backlog 的「本機資料庫的備份與還原」改為兩個後續項目：自動定期備份、正式還原的指令與演練。（2026-10-14）
- [x] **FT-01 證據瀏覽器**（P1，E4.1 的前置）— 依 subject 查事件、raw observation 的中繼資料與本文、quarantine 清單。唯讀 API，維持 GET only。 實作：唯讀 API（#34）：`GET /api/events`、`/api/raw-observations`、`/api/raw-observations/:id`、`/api/quarantine`，契約在 `packages/core/src/contracts/evidence.ts`，以單調 id 分頁、外部文字在送出前遮蔽憑證、本文最多 256 KiB；migration `0007` 為 subject 分頁與「引用某筆觀測的事件」加上索引。儀表板的「證據」頁（`apps/web/src/Evidence.tsx`）：事件依 subject 查詢（先以共用契約驗證，不接受代號）並分頁，每筆可展開 payload 與 provenance、點證據走到原始觀測；原始觀測清單；quarantine 清單。單筆觀測頁列出請求的每一項事實、原始回應、產生的事件與 quarantine 的欄位。JSON 本文以不解析數值的方式縮排（`indentJson`）：重新序列化會把 0.00000001234 寫成 1.234e-8、讓超過 2^53 的整數失去位數，那就改寫了證據。來自供應商的文字一律以文字呈現、已在 API 遮蔽。冒煙測試在 4 種畫面下走過證據頁、展開 payload、進入單筆觀測、按上一頁返回。（2026-10-14）
- [x] **UI-10 導覽骨架**（P2，需 FT-01 或 FT-02）— 第一個真正的頁面出現時再加分頁（系統／市場快照／證據／Paper／研究），不先做空分頁。 實作：隨 FT-01 的頁面加入「系統／證據」兩個分頁（`apps/web/src/route.ts`）。用路徑而不是 hash，API 對 `/api/` 以外的路徑都回 index.html，所以每一頁都能加書籤、重新整理，瀏覽器的上一頁也有效；頁內連結在新分頁開啟時是真的網址。健康輪詢在所有頁面持續，分頁標題與 favicon 照常反映狀態。市場快照、Paper、研究等分頁在各自的頁面出現時才加。（2026-10-14）
- [x] **FT-02 市場快照頁**（P1，需 FT-01）— 每個 pair 的最新 snapshot；`UNKNOWN` 顯示原因（例如「單位未確認」），不畫成 0 或空白。 實作：`GET /api/market/pairs`（`apps/runtime/src/api/market.ts`，契約 `MarketPairsPage` 在 `packages/core/src/contracts/market.ts`）回傳每個池子最新的 `pair.snapshot`：最新是最晚收到的，同時收到的（同一份回應重新解析）取最後寫入的；回補的舊觀測不會蓋過較新的。查詢是 loose index scan，走 migration `0008` 的部分索引，成本隨池子數而不是歷史長度增加；測試以 `EXPLAIN` 確認三處讀取都用這個索引。最新一筆讀不了（payload 版本較新，或不符合契約）的池子列在 `rejected`，不會靜默消失，也不會改用更舊的一筆代替。儀表板加入「市場」分頁（`apps/web/src/Market.tsx`）：依代幣分組、流動性高的在前（以 numeric 排序，不是字串）；每個 `Observed` 值只有 KNOWN 顯示數值，其餘寫出狀態與原因（「未知：單位未確認」「未知：來源未提供」），代碼在提示文字中；數值只重排千分位，不經過 JavaScript 浮點數；超過 5 分鐘的 snapshot 標示「過時」；展開可看各區間的筆數、成交量、漲跌，以及報價資產、FDV、市值、池子建立時間、來源與證據連結。頁面標示這是聚合器的狀態，不是可成交報價。代幣以 mint 識別，不顯示代號。（2026-10-14）
- [x] **FT-04 `morrow reparse`**（P2）— Parser 升版後重新解析既有證據，舊版本的事件保留不改寫。 實作：`npm run reparse [-- --dry-run]`（`apps/runtime/src/parsers/reparse.ts`）。以目前登記的 parser 版本，解析還沒被這個版本處理過的成功回應：由舊到新、每一筆一個 transaction，以 keyset 分批讀取，所以中斷後再跑一次會從停下的地方繼續；與 worker 或另一個 reparse 同時執行時，同一筆只會被解析一次（`consumer_inbox` 的標記與事件在同一個 transaction）。舊版本的事件與 quarantine 以版本作為 key 的一部分，原樣保留。`--dry-run` 只列出各 parser 的成功回應數、已解析數與待解析數。每次執行（包括沒有東西要解析的）記入 `audit_log`：開始前寫 `parser.reparse.started`，完成或出錯時寫 `completed`／`failed` 與出錯前完成的筆數，所以被中斷的執行也有紀錄。reparse 不會再解析這個版本處理過的回應，所以不檢查 parser 是否決定性，這由 parser 的測試保證。不需要 schema 變更。（2026-10-14）
- [x] **FT-05 `morrow doctor`**（P2）— 檢查工具鏈、資料庫、migration、憑證是否存在（不顯示值）、主機可達性、時鐘偏移。 實作：`npm run doctor [-- --network]`（`apps/runtime/src/app/doctor.ts`）。檢查 Node 版本（與 `engines` 同一範圍，有測試確保兩者一致）、儀表板建置、模式、資料庫連線與伺服器版本、migration、時鐘偏移（與健康報告同一個估計）、還原檢查用資料庫、`pg_dump`／`pg_restore` 的版本、`MORROW_BACKUP_DIR`、每個供應商的憑證（只列設定名稱，哪些供應商需要憑證由 registry 決定，有測試確保一致）。`--network` 對每個供應商主機做 DNS 與 TLS handshake（`providers/reachability.ts`），憑證以和 worker 相同的錯誤碼分類為 `TLS_UNTRUSTED`；不送出 HTTP 請求，`OFF` 模式拒絕。有 `FAIL` 時結束代碼為 1。資料庫連不上時，其餘不需要資料庫的檢查照常執行，錯誤訊息經過 redactor。（2026-10-14）
- [x] Helius JSON-RPC 的錯誤以 HTTP 200 加上 `error` 欄位回傳，原本會記成 `OK`。比照 OKX 加上 `readEnvelope`；M1 讀取鏈上資料前完成。 實作：`apps/runtime/src/providers/jsonrpc-envelope.ts`。每個回應都有 `result`（`null` 也算）、沒有 `error` 才是 `OK`；錯誤依 JSON-RPC 2.0 規格的代碼範圍分類（請求錯誤為 `CLIENT_ERROR`，`-32603` 與 `-32000`～`-32099` 為 `SERVER_ERROR` 並退避，其他代碼一律 `CLIENT_ERROR`），記為 `RPC_CODE_<代碼>`，訊息經過 redactor。不是 JSON、沒有 `result`、代碼不是整數、空的 batch 都不會是 `OK`。供應商特定的代碼語意留待第一次 probe 確認（見後續項目）。（2026-10-14）
