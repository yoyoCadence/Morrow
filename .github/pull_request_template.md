<!--
每個 PR 對應 tasks.md 的一個任務，結構依 AGENTS.md §4：變更、原因、風險、下一步。
不要貼任何憑證、.env 的內容或內部主機名稱。
-->

## 對應任務

<!-- 例如 RV-10、E1.2。不在 Next 或 In Progress 的任務不得開始（AGENTS.md §8）。 -->

## 變更內容

## 原因

## 驗證

<!-- 寫下實際執行的指令與結果，不是預期結果。CI 會在 PostgreSQL 17 上再跑一次。 -->

- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `npm test`：___ 個測試，全部通過
- [ ] 實機或手動驗證（若有）：

## 文件與看板

- [ ] tasks.md：任務已移到 Done，或已更新進度
- [ ] PROJECT_STATUS.md：驗證證據與測試數已更新
- [ ] 架構、契約與操作文件和實作一致（`docs/architecture.md`、`docs/contracts.md`、`docs/operations.md`、AGENTS.md §0.1）
- [ ] Schema 變更是新的 migration 檔案；沒有修改已套用的 migration

## 尚存風險

## 下一步
