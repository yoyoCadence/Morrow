# Tasks

Use this file as the lightweight task board for this project unless the project explicitly uses GitHub Issues, Linear, Notion, or another tracker.

Task IDs (E0.1, E1.1, ...) come from [docs/plans/active-plan.md](docs/plans/active-plan.md) §4. Milestone gates are in [ROADMAP.md](ROADMAP.md); evidence for completed work is in [PROJECT_STATUS.md](PROJECT_STATUS.md).

## Next

> M1 無法開始，直到下方「Blocked」的憑證由操作人提供，並完成 E1.0。

- [ ] **E1.1 MINDS evidence**（P0，需 E0.3、E1.0）— Case ingestion、cohort。完成測試：歷史與 current 不混用；缺 107 成員名單時不能標為完成。
- [ ] **E1.2 Control Paper round-trip**（P0，需 E0.2、E1.0）— Quote、risk、ledger。完成測試：真實 quote 證據；虛擬買賣守恆；沒有假 signature。

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
- [ ] 決定多個來源回報同一事件時，如何保存各自的佐證。目前相同 `dedupe_key` 的第二筆會被直接略過。
- [ ] 欄位層級 quarantine 的持久化：隨第一個 parser（M1）加入資料表。
- [ ] 本機資料庫的備份與還原（屬於 E4.2，在那之前 `pgdata` 是唯一的一份）。

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
