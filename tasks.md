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
- [ ] Helius JSON-RPC 的錯誤可能以 HTTP 200 加上 `error` 欄位回傳，目前會記成 `OK`。比照 OKX 加上 `readEnvelope`；M1 讀取鏈上資料前完成。
- [ ] 決定多個來源回報同一事件時，如何保存各自的佐證。矛盾的部分已由 RV-06 記錄在 `event_conflicts`；說的是同一個事實的第二筆仍然只是 no-op，各自的佐證沒有保存。
- [ ] 本機資料庫的備份與還原（屬於 E4.2，在那之前 `pgdata` 是唯一的一份）。審查建議提前，見 FT-06。

### 審查發現 — M2 之前完成

- [ ] **RV-11b 一次性全域格式化**（P2；**需操作人決定**）— 以 `biome.json` 的設定執行 `npm run format`，之後在 CI 強制 `biome format`。實測會改寫 31 個檔案、約 +605／−228 行（行寬 120–160 都在 30 個檔案以上），所以 AGENTS.md §2 規定要先取得同意。做的話應該是一個只含格式化的 PR，並把該 commit 加入 `.git-blame-ignore-revs`。
- [ ] **RV-12 Worker 的兩條隊伍與租約續租**（P1；D2、D3）— 同一個 worker 程序內分成「供應商請求」與「本機運算（parse 等）」兩個迴圈，節流器仍只有一份；長時間的 job 定期續租。完成測試：慢速供應商不會延遲 parse job；長 job 不會被重新派發。
- [ ] **RV-13 儲存策略**（P1；D4、D5）— 先量測（FT-07），再決定：quarantine 是否改為每個 observation 一筆彙總、或只記錄新出現的原因；raw payload 與事件的保留期限；`jobs`、`consumer_inbox` 的清理。決策寫成 ADR。完成測試：依決策的保留規則不會刪到 replay 需要的證據。
- [ ] **RV-14 開發相依的弱點**（P2）— `source-map-js@1.2.1`（經 vite → postcss，只在建置時使用）升級到修正版，遵守 `.npmrc` 的 `min-release-age`。
- [ ] **RV-15 API 請求日誌**（P2；U9）— Health 輪詢不要每次寫 2 行 info 日誌（開著分頁每天約 1.7 萬行）；錯誤與非 GET 請求照常記錄。

### UI 改善

依賴 RV-01／RV-03 提供的欄位。設計原則：這是操作工具，不是交易終端；視覺先回答「能不能相信這個畫面」，不做會誘發追高的動態效果（審查 §6）。

- [ ] **UI-01 新鮮度與相對時間**（P1，需 RV-01；U1、U5）— 心跳、最近成功等改為「12 秒前」，完整時間放在 tooltip；過期 session 的紅色「心跳中斷」徽章已隨 RV-01 完成；頁首顯示「上次更新」與更新指示點。
- [ ] **UI-02 頁首狀態列**（P1，需 RV-03；U4）— 四級整體狀態與對應顏色；小指標：worker 心跳、健康來源數、最高額度使用率、dead job 數；分頁標題與 favicon 隨狀態變化。
- [ ] **UI-03 資料來源表**（P1，需 RV-03；U2、U6）— 修正 1280 px 下的截斷；依供應商分組、問題排最前面、「只看異常」篩選；顯示錯誤類別與額度桶；退避中顯示剩餘時間。
- [ ] **UI-04 額度視覺**（P2；U7）— 自繪進度條標出警告線、硬性上限與供應商上限，顏色與狀態一致；依本月燃燒率推估達到硬性上限的日期。
- [ ] **UI-05 觀測覆蓋帶**（P1）— 近 24 小時與 7 天的時間軸，標出觀測中與缺口，附覆蓋率百分比。需要 API 提供時間範圍內的 session 與 gap。
- [ ] **UI-06 窄螢幕版面**（P2；U3）— 640 px 以下表格改為卡片清單，狀態放在第一行。
- [ ] **UI-07 輪詢穩健性**（P1；U8）— 請求逾時與取消、不重疊、分頁在背景時暫停、以 `HealthReport` schema 驗證回應以發現契約漂移。
- [ ] **UI-08 無障礙**（P2）— 表格 caption、清楚的焦點樣式、`prefers-reduced-motion`、狀態不只靠顏色表達。
- [ ] **UI-09 前端測試**（P2，需 RV-05）— 狀態判斷抽成純函式並以 `node:test` 測試；CI 加一個 Playwright 冒煙測試（亮色、深色、390 px）。
- [ ] **UI-10 導覽骨架**（P2，需 FT-01 或 FT-02）— 第一個真正的頁面出現時再加分頁（系統／市場快照／證據／Paper／研究），不先做空分頁。

### 功能建議

都在 M0–M4 授權範圍內，不新增費用。

- [ ] **FT-01 證據瀏覽器**（P1，E4.1 的前置）— 依 subject 查事件、raw observation 的中繼資料與本文、quarantine 清單。唯讀 API，維持 GET only。
- [ ] **FT-02 市場快照頁**（P1，需 FT-01）— 每個 pair 的最新 snapshot；`UNKNOWN` 顯示原因（例如「單位未確認」），不畫成 0 或空白。
- [ ] **FT-03 排程器**（P0，M2 的前置）— slot 化的 dedupe key（例如 `schedule:<名稱>:<slot>`）；停機後只跑最新的 slot，錯過的部分記成缺口，不一次補發。
- [ ] **FT-04 `morrow reparse`**（P2）— Parser 升版後重新解析既有證據，舊版本的事件保留不改寫。
- [ ] **FT-05 `morrow doctor`**（P2）— 檢查工具鏈、資料庫、migration、憑證是否存在（不顯示值）、主機可達性、時鐘偏移。
- [ ] **FT-06 備份與還原提前**（P1）— `pg_dump` 到資料目錄之外，並還原到獨立的測試資料庫驗證；不得覆蓋使用中的資料庫。
- [ ] **FT-07 儲存量測**（P1，RV-13 的前置）— `morrow status` 顯示各資料表大小與每日成長。
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
