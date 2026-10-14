# Project status

目前階段、驗證證據、阻礙與下一步。這是唯一的狀態文件；里程碑定義在 [ROADMAP.md](ROADMAP.md)，任務在 [tasks.md](tasks.md)。

最後更新：2026-10-13

## 現況

- **M0（基礎與契約）完成。** 五項完成門檻中四項達成；第五項「保存 provider entitlement probes」的機制完成且結果已保存，但除了不需要金鑰的 DEX Screener，還沒有取得任何供應商的實際權限資料。
- **E1.0 進行中。** 13 個功能的端點都已對照官方文件核對並補齊，OKX 各端點也已依官方價目頁分到 Basic 或 Premium 額度桶。在目前的開發機上實際跑 probe：DEX Screener 回 200，其餘 12 個因為沒有憑證而沒有送出。
- **M1 受阻**，現在只剩憑證。網路問題在目前的開發機上不存在。見「阻礙」。
- 系統只有 probe 會取得市場資料。DEX Screener `tokens/v1` 的回應會被解析成 `market/pair.snapshot` 事件（PR #5）；沒有其他 parser，也沒有任何交易功能，Paper 的也沒有。
- **2026-10-13 完成一次專案審查**，結論在 [docs/reviews/2026-10-13-project-review.md](docs/reviews/2026-10-13-project-review.md)。重現了 4 個影響「誠實呈現」的問題（worker 當掉仍顯示運作正常、單一 pair 讓整個回應解析失敗、404 與 OKX 錯誤碼顯示為 HEALTHY、資料庫連線沒有逾時），修正項目列為 tasks.md 的 `RV-01`～`RV-05`，不需要憑證。

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
| CI（2026-10-13 起，RV-05） | 每個 PR 與 `main` 自動執行 typecheck、build、全部測試（PostgreSQL 17）、儀表板冒煙測試（Chromium，UI-09 起）與 migration 冒煙測試 |

### Automated

`npm test`：**353 個測試全部通過**，其中 187 個不需要資料庫（50 個是儀表板的，UI-09 起），166 個對真實的 PostgreSQL 執行。每個資料庫測試檔使用自己的 schema，結束後刪除。另有 `npm run test:e2e`：在 Chromium 中以 4 種畫面（亮色、深色 × 1280、390 px）檢查建置好的儀表板的系統頁、市場頁、證據頁與單筆觀測頁，不包含在 `npm test` 裡。（M0 交付時為 148 個；E1.0 新增 5 個，見下方「其他涵蓋」；PR #5 的 DEX Screener parser 新增 17 個。2026-10-13 的審查在 Linux、Node 24.19.0、PostgreSQL 16.15 上重跑，170 個全部通過；之後的審查修正見下方。）

#### 審查修正（2026-10-13 起）

每項一個 PR，任務定義在 [tasks.md](tasks.md)。

| 項目 | 內容 | 驗證 |
|---|---|---|
| RV-01 Health 新鮮度 | Session 多了推導出來的 `liveness`；有心跳中斷的程序，或 `RESEARCH`／`PAPER` 下沒有活著的 worker，health 就不是 `ok`；`npm run stop` 能辨認已經死掉的程序 | 新增 2 個 DB 測試；實機 `kill -9` worker 後，health 為 `degraded`、worker 為 `STALE`，`npm run stop` 立即回報 not running |
| RV-02 Parser 單筆隔離 | 契約無法表示的數值（例如 `1e-120`、`1e+100`、97 位數）在欄位層級成為 `UNKNOWN (NOT_REPRESENTABLE)` 並保存原文；仍不符合契約的 pair 以 `SCHEMA_REJECTED` 進 quarantine；parser 升版為 `dexscreener-tokens@2` | 新增 3 個測試：兩個 pair 的回應產生 2 個事件，正常的 pair 與單獨解析時完全相同；ingest 不丟錯 |
| RV-03 來源狀態與四級整體狀態 | 新的來源狀態 `REQUEST_REJECTED`（migration `0003`）；health 為 `ok`／`attention`／`degraded`／`critical`，並列出每一個原因（`findings`）；來源檢視顯示錯誤類別（例如 `OKX_CODE_51000`）；dashboard 頁首列出原因 | 新增 2 個 DB 測試（嚴重度與錯誤類別、`0003` 的資料轉換），更新 3 個；截圖確認亮色與深色 |
| RV-04 資料庫逾時 | 連線、語句、等待回應、閒置 transaction 都有上限，心跳另有 5 秒上限；`migrate` 不設語句上限；狀態不明的連線被銷毀 | 新增 7 個測試（含一個只接受連線、從不回應的假伺服器）；審查時連到黑洞位址會無限期等待，現在 10 秒後回報 `connection timed out` |
| RV-05 CI | GitHub Actions：ubuntu-24.04、Node 24.19.0、PostgreSQL 17.11 service container；typecheck、build、全部測試、migration 冒煙測試；actions 以 commit 釘住，不使用 secret | 同一個 PR 先推一個故意失敗的測試：[run 38411115251](https://github.com/yoyoCadence/Morrow/actions/runs/38411115251) 為 185 個測試中 1 個失敗（只有該測試），job 失敗；移除後重跑為綠。審查與 RV-01～RV-04 是在 PostgreSQL 16 上驗證的，這是之後第一次在目標版本 17 上跑完整測試 |
| RV-06 矛盾資料可見 | 同一個 `dedupe_key` 卻說了不同事實的事件，記錄在 append-only 的 `event_conflicts`（migration `0004`）；同一個事實重送仍是 no-op；health 對近 24 小時的矛盾給出「需注意」 | 新增 7 個測試：canonical JSON、fact hash 不受 provenance／key 順序／時間寫法影響、矛盾只記錄一次且保留證據、0004 之前的事件以推導的 hash 比對、health finding。Codex review 的 2 個意見（舊事件無法比對、`schema_version` 不應計入）都已修正 |
| RV-07 `confidence` 精度 | 契約限制最多 6 位小數，與 `events.confidence numeric(7,6)` 一致；更細的值在寫入前被拒絕，不再被資料庫靜默四捨五入 | 新增 2 個測試（可接受的值、存回的值與送出的完全相同），並在拒絕案例中加入 7 位小數 |
| RV-08 Provider 層級退避 | 限制屬於整個金鑰的供應商（Jupiter、Helius、暫定 OKX），一個功能被 429 時暫停該供應商的所有功能；DEX Screener 依端點限流，只暫停該端點 | 新增 3 個測試：同一供應商的其他功能被 `SUPPRESSED` 且沒有送出、其他供應商不受影響、到期後成功即清除；依端點限流的供應商不受影響；各供應商宣告的範圍 |
| RV-09 簽章時間與時鐘偏移 | 節流等待之後才以當下時間簽章；每個回應的 `Date` 存進 `raw_observations.server_date`，偏移以收到 header 的時間估計存進 `clock_offset_ms`（migration `0005`）；health 以近期回應的中位數估計時鐘偏移，樣本不足為未知；dashboard 頁首顯示偏移 | 新增 6 個測試：等待 5 秒後的簽章時間、`Date` header 的保存與解析、偏移公式、body 傳輸 1.5 秒不被算成偏移、差好幾年的時鐘仍能記錄、偏移的嚴重度與中位數、樣本不足為 null。Codex review 的意見（body 傳輸時間被算成偏移）已修正；修正時測試抓到 `integer` 會溢位，改為 bigint |
| RV-10 PR 範本 | `.github/pull_request_template.md`：對應任務、變更、原因、實際執行的驗證、文件與看板的勾選項（tasks.md、PROJECT_STATUS、架構與契約文件、migration 不可修改）、風險、下一步 | 文件變更；這個 PR 本身就是用新範本的結構撰寫 |
| RV-11 Lint | Biome 2.5.15 只作 linter，CI 執行 `npm run lint`；recommended 規則，關掉 2 個純風格規則；修正 3 個問題（隱含 any、`forEach` 回傳值、React 以 index 當 key）。全域格式化會改寫 31 個檔案，依 AGENTS.md §2 待操作人決定（RV-11b） | `npm run lint` 無錯誤；202 個測試全過，parser 的輸出不變（決定性測試） |
| RV-14 開發相依弱點 | `source-map-js` 1.2.1 → 1.2.2（只改 lockfile；經 vite → postcss，只在建置時使用） | `npm audit`：0 個弱點；`npm run build` 通過 |
| RV-15 API 請求日誌 | 每個請求只在完成時寫一行；成功的讀取記 debug，Host／Origin 被拒記 warn，其他拒絕與非讀取記 info，5xx 記 error。預設的 info 層級下，健康輪詢不再寫日誌 | 新增 2 個不需資料庫的測試（各狀態的層級、整條請求的實際輸出）；拿掉 controller 時測試失敗；204 個測試全過 |
| RV-12 Worker 隊伍與續租 | Worker 分成 `local`（parse）與 `network`（供應商與未宣告的種類）兩個迴圈，各自一次一個；執行中的 job 每三分之一租約續租 | 新增 3 個資料庫測試：慢的供應商 job 執行中 parse 照常完成；長 job 在最後一次與非最後一次嘗試都不會被取走或判為 dead；租約被取走時記錄且不算成功。拿掉續租或合併隊伍時對應的測試失敗；207 個測試全過 |
| FT-07／RV-13 儲存量測 | `npm run storage` 列出各表大小與近 24 小時成長；實測每個 pair 快照約 4.8 KB（30 個 pair 一次的回應），一半是 quarantine。保留策略寫成 ADR-0001（提案，待操作人決定） | 新增 5 個測試（2 個需資料庫：每張表都已登記、成長的計算與未知的表示）；212 個測試全過 |
| UI-01 新鮮度與相對時間 | 心跳、最近成功、暫停至改為相對時間（以伺服器時間計算，tooltip 是完整台北時間）；頁首的上次更新與靜態狀態點；API 無回應時最後的報告變灰 | 以 Playwright（Chromium）在亮色、深色與 390 px 下截圖，含 API 失敗 36 秒後的畫面；修正一個只在截圖中出現的問題（剛收到報告時顯示「即將」）；typecheck、build、lint 通過。後續修正：改從送出請求起算，模擬回應延遲 8 秒時，3 秒前的心跳原本顯示「3 秒前」，修正後為「11 秒前」 |
| UI-02 頁首狀態列 | 整體狀態列與 4 個小指標（worker 心跳、健康來源數、最高額度使用率、失敗終止的工作）；分頁標題與 favicon 隨狀態改變 | Playwright 截圖（亮色、深色，需注意與異常兩種狀態）；驗證標題與 favicon 依序為「需注意」、「異常」、API 失敗後「連線中斷」；5 個 favicon 在 16 px 的亮、暗分頁列都可分辨；typecheck、build、lint 通過 |
| UI-03 資料來源表 | 依供應商分組、問題排前面、「只看異常」、額度桶與用量（契約新增 `quota_bucket`） | Playwright 以 registry 的全部 14 個功能與 4 種異常狀態測試：排序為 okx、helius、jupiter、dexscreener；篩選後只剩 4 列並記住選擇；1280 px 的捲動寬度等於可見寬度（修正前 1207 對 1046）；新增 1 個不需資料庫的測試（`quotaBucketOf`），資料庫測試多驗證一個欄位；213 個測試全過 |
| UI-04 額度視覺 | SVG 進度條標出警告線、硬性上限與供應商上限（契約新增 `source_limit`）；依本月平均速度推估何時達到硬性上限 | Playwright 以固定時間 10/13 12:00 UTC 驗證推估：30,000 用量為「月底約為上限的 87%」、61,000 為「約 10/18」（台北日期），10/01 06:00 時不推估、10/02 06:00 起推估；送出 API 的 CSP header 時沒有任何違規；1280 px 不橫向捲動；資料庫測試驗證 `source_limit` 高於硬性上限；213 個測試全過 |
| UI-05 觀測覆蓋帶 | 新端點 `GET /api/coverage?hours=24|168`，以 session 與缺口算出連續區段與覆蓋率；儀表板畫近 24 小時與 7 天兩條 | 新增 6 個不需資料庫的測試（各種缺口、合併、裁切、重新啟動的縫隙）與 3 個資料庫測試（真實查詢、端點只接受 24 與 168、資料庫無法連線時回 503 且不外露錯誤）；以真實的 API 伺服器與種好的資料端到端截圖：近 24 小時 77.0%、近 7 天 50.2%，與人工驗算一致，CSP 違規 0，1280 與 390 px 都沒有橫向捲動；222 個測試全過 |
| UI-07 輪詢穩健性 | 請求逾時（15 秒）與取消、不重疊、背景時放慢、以契約 schema 驗證回應 | Playwright 以模擬 API 驗證：缺少 `clock` 的回應被認出並指出欄位，最後的報告變灰；20 秒才回應時 16 秒後顯示逾時，同時在途的請求最多 1 個；header 準時送出、本文卡住時也算逾時，不會誤報成版本不一致；前景 2 分鐘 12 次、背景 4 分鐘 4 次，回到前景立刻 1 次。bundle 由 242 KB 增為 341 KB（gzip 後 104 KB），主要是 zod |
| UI-06 窄螢幕版面 | 640 px 以下表格改為卡片，第一行是對象與狀態；空的行省略 | Playwright 以完整的模擬報告（14 個來源、2 個 session、缺口、3 個額度桶、覆蓋）在 390、640、1280 px 量測：頁面與每張卡片的橫向溢出都是 0；截圖確認亮色、深色與寬版不變；修正兩個只在截圖中出現的問題（卡片標題的多餘空白、flex 吃掉空格）；222 個測試全過 |
| UI-08 無障礙 | 表頭語意、caption、窄版標籤不重複朗讀、窄版不丟格、焦點外框、覆蓋帶斜紋 | 以 Playwright 的無障礙樹量測修正前後：表格名稱 0→4、columnheader 0→24、窄版格數 129→127（與寬版相同）、窄版列名稱不再含標籤；第一次按 Tab 焦點在篩選核取方塊，外框 2 px；截圖確認斜紋與圖例；lint 沒有警告；222 個測試全過 |
| UI-09 前端測試 | 儀表板的純函式與輪詢以 `node:test` 測試（35 個，納入 `npm test`）；`npm run test:e2e` 以真實的 API 與種好的資料庫在 Chromium 中檢查亮色、深色、1280 與 390 px；CI 執行冒煙測試 | 每個主要行為以突變驗證：改回先除後乘、拿掉本文逾時的判斷（#28）、資料庫不完整時不顯示未知、伺服器時間倒退、輪詢重疊、背景不放慢、回前景不更新、停止後仍執行，對應的測試都會失敗。測試找到兩個問題並修正：額度 29% 顯示為 28%（浮點），以及自 UI-07 起每次載入都有的 CSP 違規（zod 試探 `new Function`；改為 `jitless` 後冒煙測試的主控台為空）。設定接受 `MORROW_E2E_CHROMIUM`（新增 1 個測試）；258 個測試與冒煙測試全過 |
| FT-03 排程器 | 固定排程：slot 對齊 UTC、每個 slot 一個 job（`schedule:<名稱>:<slot>`）；停機後只跑目前的 slot，錯過的記成一列 `NOT_SCHEDULED`；上一個 job 還在排隊就跳過並記 `BACKLOG`；本機時鐘與供應商差超過 30 秒時暫停並記 `CLOCK_SKEW`（migration `0006`）。目前沒有登記任何排程 | 新增 17 個測試（3 個不需資料庫；11 個排程情境：首次、正常推進、停機、積壓、積壓跨停機、時鐘不可信時暫停、積壓中時鐘出問題、改 slot 長度、時鐘倒退、6 個並行 tick 只排一次、偏移過大（快或慢）暫停而未知不暫停；3 個 worker 整合：`RESEARCH` 實際排入並執行、近期回應顯示時鐘差 40 秒時不送出任何請求、`OFF` 不排程且沒有 handler 時在記錄 session 前拒絕啟動）。突變驗證：拿掉積壓跳過、停機缺口、列鎖、slot 邊界判斷、時鐘倒退判斷、積壓結束的紀錄、錯誤攔截、時鐘暫停（含只擋慢的一邊、未知也暫停、原因改變不分段），對應的測試都會失敗。全新資料庫 migrate 兩次：第一次套用 0001–0006，第二次為 no-op；275 個測試全過 |
| FT-06 備份與還原檢查 | `npm run backup`：同一個 snapshot 的 `pg_dump` 與 manifest（各表列數、trigger、migration、SHA-256），寫完立刻還原到 `<資料庫>_restore_check` 逐項核對，通過才記下 `restore_check`；不會碰使用中的資料庫 | 新增 11 個測試（5 個不需資料庫：檢查用資料庫的命名、備份資料夾必須在 repo 之外、密碼只經環境變數且繼承的 `PG*` 被移除、工具版本解析、archive 是否建立 schema；6 個資料庫測試：完整備份與還原並核對、`public` schema 本身（`npm run backup` 實際備份的對象，連續兩次）、持續寫入時列數與傾印一致、損壞的檔案在還原前被拒絕、內容不符時報告並保留、檢查用資料庫不存在時在傾印前停止）。突變驗證：拿掉共用 snapshot、SHA-256 檢查、逐表核對、成功後的清理，或一律自己建立 schema，對應的測試都會失敗。CLI 實測：未設定、相對路徑、在 repo 內、找不到 pg_dump、沒有檢查用資料庫都給出明確訊息且不寫出檔案，成功時 17 張表全部核對通過；286 個測試全過 |
| FT-01 證據瀏覽器（API） | 唯讀端點：某個 subject 的事件、送出過的請求、單筆請求的本文與從它 quarantine 的欄位及產生的事件、quarantine 清單；以單調 id 分頁；外部文字送出前遮蔽憑證，資料庫的位元組不變；migration `0007` 加兩個索引。頁面待 FT-01b | 新增 14 個測試（6 個不需資料庫：參數驗證含超出 bigint 的游標、本文在多位元組字元中間截斷、非 UTF-8、遮蔽；8 個資料庫測試以真實的 DEX Screener 回應走完 ingest：分頁、本文與 quarantine 與事件的對應、錯誤回應裡的金鑰被遮蔽而儲存的位元組不變、大本文截斷、二進位本文、清單與篩選、400／404／405、資料庫無法連線時 503）。每個回應都以共用契約驗證。突變驗證：拿掉本文或錯誤訊息的遮蔽、分頁的多取一筆、新的在前、只讀本文開頭、subject 篩選、bigint 上限，對應的測試都會失敗。全新資料庫 migrate 兩次通過；300 個測試全過 |
| FT-01 證據瀏覽器（頁面）與 UI-10 導覽 | 儀表板分成「系統」與「證據」兩頁（路徑路由，可加書籤、上一頁有效）。證據頁：依 subject 查事件並分頁、展開 payload 與 provenance、點證據到原始觀測；原始觀測與 quarantine 清單。單筆觀測頁：請求的事實、原始回應（數字照原樣縮排）、產生的事件、quarantine 的欄位 | 新增 8 個儀表板測試（路由的對應與往返、subject 縮寫、證據參照、每種請求結果的色調、大小格式、JSON 縮排不改動任何數字與字串、只縮排完整的 JSON）。冒煙測試在亮色、深色、1280、390 px 走過證據頁、展開 payload、單筆觀測頁、上一頁，主控台沒有任何錯誤，頁面與卡片都不橫向捲動。截圖檢查時發現並修正兩個版面問題：payload 原本在表格的一格內展開，擠壓其他欄位；窄版時它還繼承了卡片的靠右對齊。改為表格下方獨立的一整列並靠左。Codex 審查後：清單載入失敗時保留「重試」（只重取失敗的那一頁，已載入的保留；冒煙測試以攔截的 503 驗證），資產的縮寫保留 namespace 與 network；308 個測試全過 |
| FT-02 市場快照頁 | `GET /api/market/pairs` 回傳每個池子最新的 snapshot（最晚收到的；同時收到的取最後寫入的，也就是重新解析的結果），以 loose index scan 走 migration `0008` 的部分索引，成本隨池子數增加而不是歷史長度；最新一筆讀不了的池子列在 `rejected`，不改用舊的一筆。儀表板新增「市場」分頁：依代幣分組、流動性高的在前；不是 KNOWN 的值寫出狀態與原因（例如「未知：單位未確認」），不畫成 0 或空白；超過 5 分鐘標示「過時」；展開看各區間與其餘欄位 | 新增 8 個資料庫測試（回補的舊觀測不蓋過新的、重新解析在 recorded_seq 跨位數時仍取最後寫入的、流動性以數值而非字串排序且未知的排最後、payload 版本較新或不符契約時列為 rejected 而不改用舊的一筆、無法轉成 numeric 的值不會讓整個查詢失敗、超過上限時標示截斷且依資料庫自己的排序保留、`EXPLAIN` 確認三處讀取都走索引、以真實回應走完 ingest 的端點與 503）與 7 個儀表板測試（千分位不改動任何位數、分數轉百分比、過時門檻、每種狀態的文字、原因標籤不受 `constructor` 等物件鍵影響、四個區間相同的未知只說一次）。突變驗證：改成依 recorded_seq 的字串或只依寫入順序、流動性改成字串排序、未知排前面、拿掉 numeric 轉換前的檢查、拿掉截斷判斷或版本檢查、拿掉索引，對應的測試都會失敗。測試抓到一個錯誤：LATERAL 子查詢的 `ORDER BY recorded_seq` 綁到了輸出的文字欄位，同時收到的 snapshot 會以字串比較（"9" 排在 "12" 之後）。冒煙測試在 4 種畫面走過市場頁並展開細節；截圖檢查後修正窄版一格多個元素被拆開、細節兩欄被拉成同高的問題；323 個測試全過 |
| FT-04 重新解析 | `npm run reparse [-- --dry-run]`：以目前的 parser 版本解析還沒被它處理過的成功回應，由舊到新、每一筆一個 transaction；舊版本的事件與 quarantine 原樣保留；中斷後再跑會接著做。每次執行（包括沒有東西要解析的）都記入 `audit_log`：開始前 `started`，完成或出錯時 `completed`／`failed` 與出錯前完成的筆數。不需要 schema 變更 | 新增 7 個資料庫測試與 1 個 CLI 測試：計畫只算成功回應且不寫入任何東西；舊版本解析過、從未解析過、目前版本已解析過三種回應中只解析前兩種，舊版本的事件逐欄不變，第二次執行什麼都不做；跨批次邊界（中間一筆已解析）每筆恰好一次；兩個 reparse 同時執行時合計恰好每筆一次；audit 的內容；沒有東西要解析時也有紀錄；第二筆時連線中斷，`failed` 記下已完成的 1 筆與錯誤代碼、不含訊息，再執行一次完成其餘 2 筆；不認得的選項在連線前以結束代碼 2 拒絕；live 模式照樣被拒絕。突變驗證：待解析不看處理標記、不限成功回應、滿一批就停、拿掉任一筆 audit、`failed` 漏掉進行中的 parser、標記的前綴錯誤，對應的測試都會失敗。Codex 審查後：拿掉「同一版本結果不一致時結束代碼 1」的保證（已處理的回應不會再解析，這個檢查永遠不會觸發），並讓每次執行都有 audit。在暫存資料庫實際執行 CLI：250 筆中 10 筆已解析，`--dry-run` 列出 240 筆待解析且不寫入，實際執行 1.3 秒解析 240 筆；331 個測試全過 |
| FT-05 環境檢查 | `npm run doctor [-- --network]`：Node 版本、儀表板建置、模式、資料庫連線與版本、migration、時鐘偏移、還原檢查用資料庫、`pg_dump`／`pg_restore`、備份資料夾、各供應商的憑證是否設定（只列設定名稱）。`--network` 對每個供應商主機做 DNS 與 TLS handshake，不送出請求，`OFF` 模式拒絕。有 `FAIL` 時結束代碼 1 | 新增 15 個不需資料庫的測試與 4 個資料庫測試：支援的 Node 範圍與 `engines` 相同、範圍內外的版本；需要憑證的供應商與 registry 的 `authorize` 一致；憑證只列名稱、5 個值都不會出現在輸出；備份資料夾的三種錯誤；時鐘偏移的未知與門檻；工具版本；憑證錯誤分類為 `TLS_UNTRUSTED`（與 worker 同一組錯誤碼）；本機 socket 上的 DNS 失敗、連線被拒、沒有回應時在要求的 300 ms 放棄、對方不講 TLS；已 migrate 與未 migrate 的資料庫；資料庫連不上時密碼不出現在輸出且其餘檢查照常執行；`--network` 每個主機一列。CLI：不認得的選項與 `OFF` 下的 `--network` 都在連線前拒絕。突變驗證：印出憑證值、接受任何 24.x 或 25、偏移門檻改成含等號、不辨認憑證錯誤、忽略要求的逾時，對應的測試都會失敗。另以 openssl 產生的暫時憑證（未提交）手動驗證真正的 handshake：信任時為 `OK`，自簽為 `TLS_UNTRUSTED (DEPTH_ZERO_SELF_SIGNED_CERT)`，名稱不符為 `TLS_UNTRUSTED (ERR_TLS_CERT_ALTNAME_INVALID)`。Codex 審查後修正三處並各加測試（每個測試在修正前的程式上都會失敗）：備份資料夾指向一個檔案時為 FAIL（原本因為「存在」而 OK）；DNS 查詢也在 5 秒逾時內（原本 DNS 卡住會等到作業系統的逾時）；資料庫回應版本後的查詢失敗、或 `pg_dump` 在 PATH 上卻無法執行時，記成該項的 FAIL／WARN 並繼續（原本例外會讓整份報告消失）；353 個測試全過 |

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

E1.0 新增（OKX envelope，`providers.test`、`client.dbtest`）：OKX 以 HTTP 200 回傳錯誤 `code` 時，依代碼分類為 `RATE_LIMITED`／`UNAUTHORIZED`／`SERVER_ERROR`／`CLIENT_ERROR`，不會記成 `OK`；`code` 為 `"0"` 或 `0`、或沒有 envelope 的陣列才算成功；原始回應照樣存證，`error_class` 記錄 `OKX_CODE_<code>`；只有 OKX 讀 envelope。

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
- OKX 用 HTTP 200 加上錯誤 `code` 回報失敗的情況，現在由 `okx-envelope.ts` 依代碼分類，不會再記成 `OK`。代碼對照來自 OKX 官方 skills repo 的錯誤碼表與官方 CLI，但只用假伺服器測過；真實回應的 `code` 格式，要等有 OKX 憑證跑 probe 時確認。
- Helius 是 JSON-RPC：RPC 層的錯誤（例如節點不健康）可能以 HTTP 200 加上 `error` 欄位回傳，目前仍會記成 `OK`。驗證失敗是否一定以 HTTP 401 回傳還沒實測；有 Helius 憑證跑 probe 時要打開原始回應確認。M1 讀取鏈上資料前要處理，已列入 Backlog。
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
| Git 流程（2026-10-13） | Agent 不 push、不開 PR、不 merge | 審查的 PR 由 agent 開立並合併 | 操作人於 2026-10-13 對本次審查任務明確要求「開 PR 並合併」 |
| 任務看板 | 不在 Next／In Progress 的任務不得開始（AGENTS.md §8） | PR #5（DEX Screener parser、migration 0002）合併時不在看板上，也沒有更新狀態文件 | 2026-10-13 審查時補記到 tasks.md 的 Done；之後以 PR 範本把關（RV-10） |

沒有降低任何驗收標準。無法取得的 live 證據維持 pending。

## 下一步

1. 操作人申請 Jupiter、Helius、OKX 的免費唯讀憑證並寫入 `.env`（阻礙 2）。
2. **E1.0 收尾**：在目前的開發機重跑 `npm run probe`，把 12 個功能的實測結果記在這裡；OKX 的結果已會依回應的 `code` 分類，第一次仍要打開原始回應確認格式與文件一致。每個功能都是 `OK`，或有明確結論的 `PAYMENT_REQUIRED`／`UNAUTHORIZED`，E1.0 才算完成。
3. 之後才開始 E1.1 與 E1.2。
4. 與 1、2 平行：tasks.md「審查修正」的 `RV-01`～`RV-05`（health 新鮮度、parser 單筆隔離、來源狀態語意、資料庫逾時、CI）。不需要憑證，但不應因此延後第 1 步。

## 交接備註

- 新增供應商功能：在 [registry.ts](apps/runtime/src/providers/registry.ts) 加一筆 `CapabilityDefinition`。計量供應商必須指定 `quotaBucket`，而且該額度桶要有對應的 policy。對照官方文件後才設 `docVerified: true`，並在 `note` 寫下依據的網址與日期；OKX 的額度桶以官方價目頁為準。
- 單位不一致是已知的：OKX holder 的 `holdPercent` 與 cluster overview 的百分比是 0–100，cluster list／top-holders 的 `holdingPercent` 是 0–1 的比例。Parser 不可混用。
- 所有對供應商的請求都必須經過 `ProviderClient.request()`，不要直接呼叫 `fetch`。
- 新的 job handler 在 [processes.ts](apps/runtime/src/app/processes.ts) 的 `defaultHandlers` 註冊。Handler 必須能安全地重複執行；用 `markProcessed` 在同一個 transaction 內去重。
- 已套用的 migration 不可修改，只能新增。
- 測試不可連到真實的供應商。資料庫測試需要 `MORROW_TEST_DATABASE_URL`，且資料庫名稱必須以 `_test` 結尾。
