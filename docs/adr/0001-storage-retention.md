# ADR-0001 儲存與保留策略

- **狀態**：提案。等待操作人決定，見「需要操作人決定的事項」。決定之後把狀態改為「已採用」或「已拒絕」，並記錄日期。
- **日期**：2026-10-13
- **對應**：RV-13（審查 D4、D5）、FT-07

## 背景

Morrow 把供應商的原始回應與衍生出來的事件都存在本機 PostgreSQL。證據表是 append-only，由 trigger 擋下刪改。資料目錄還沒有備份。

審查 D5 以估計值推算每月「十幾 GB」。這份 ADR 改用實測數字，並先分清楚哪些資料是證據、哪些可以重建，再決定保留規則。

## 量測

**方法**：`scripts/measure-snapshot-storage.mjs`，以已存的真實 DEX Screener 回應為範本。

- 每個 pair 有自己的地址，每次觀測有自己的價格，所以每個 body 都不同，與正式運作相同。
- 走真實的路徑：存證、在同一個 transaction 排 parse job、parse、完成 job。
- `VACUUM ANALYZE` 之後比較 `pg_total_relation_size`，數字包含索引與 TOAST。
- 環境：PostgreSQL 16、Linux。

`tokens/v1` 一次最多查 30 個 token，所以主要情境是每個回應 30 個 pair，共 6,000 個 pair 快照：

| 表 | 每個 pair 快照 | 佔比 | 說明 |
|---|---:|---:|---|
| `parse_quarantine` | 2,411 B（8 列） | 50% | 每次都是同樣 8 個欄位（`volume.*`、`priceChange.*`），原因都是 `UNIT_UNVERIFIED` |
| `events` | 2,148 B（1 列） | 44% | Payload 是 1,458 B 的 JSON，低於 TOAST 的 2 KB 門檻，所以沒有壓縮 |
| `raw_payloads` | 209 B | 4% | 30 個 pair 的 body 約 48 KB，由 TOAST（pglz）壓縮。真實的 body 彼此差異較大，壓縮率會低一些 |
| `raw_observations`、`jobs`、`consumer_inbox` | 共約 2.1 KB／每個回應 | 1.5% | 每 30 個 pair 分攤一次 |
| **合計** | **約 4.8 KB** | | |

每個回應只有 1 個 pair 時，每個快照約 7.7 KB：每個回應的固定成本無法分攤，body 也短到不會被壓縮。

**試過但不採用**：把 `events` 設成 `toast_tuple_target = 128`，結果反而變大，每個 30 pair 的回應從 64 KB 增加到 74 KB。PostgreSQL 把值搬到 TOAST 表，而不是在原地壓縮。

## 推算

依藍圖的固定排程：

- 300 個 warm 資產每 5 分鐘一次 batch 快照。
- 6 個 active 資產每 60 秒一次。
- 沿用審查的假設，每個資產平均 1.5 個 pair。

合計每天約 142,560 個 pair 快照、約 4,320 個請求。以 2 進位單位計：

| 情境 | 每天 | 每 30 天 | 每年 |
|---|---:|---:|---:|
| 現況，24 小時運作 | 658 MB | 19.3 GB | 234 GB |
| 現況，每天運作 8 小時 | 219 MB | 6.4 GB | 78 GB |
| Quarantine 只記第一次（Q2），24 小時 | 330 MB | 9.7 GB | 118 GB |
| Quarantine 只記第一次（Q2），每天 8 小時 | 110 MB | 3.2 GB | 39 GB |

**這對 M0–M4 不急。** MVP 的驗收是三次各至少 60 分鐘的 session，就算 24 小時連續運作兩個月也只有約 40 GB。真正的問題在後面：

- 長期運作時每年上百 GB，而且還沒有備份（FT-06）。
- 一半的空間花在可以完全重建的資料上，見下一節。

## 各類資料的性質

| 資料 | 性質 | 能否重建 |
|---|---|---|
| `raw_payloads`、`raw_observations` | 證據：當時收到的位元組與時間 | 不能。供應商不會再給一次過去的回應 |
| `events` | 衍生資料，但 `available_at`（何時知道）是寫入當下的時間 | 內容可以由 parser 重建，時間不能。Point-in-time 研究依賴這個時間 |
| `parse_quarantine` | 衍生資料。`raw_value` 就在 raw payload 裡；原因已記在 event payload 的 `UNKNOWN` 與其 `reason` 裡；parser 是決定性的（有測試） | 能，完全重建 |
| `event_conflicts`、`audit_log`、`session_gaps`、`provider_probes`、`quota_events`、`run_sessions` | 稽核紀錄，量很小 | 不能 |
| 已完成的 `jobs`、`consumer_inbox` | 運作狀態 | 不需要。事件與 quarantine 的寫入都是冪等的（`ON CONFLICT DO NOTHING`，事件另外比對 fact hash），重新處理不會產生重複的效果 |

## 選項

### Quarantine

- **Q1 維持現狀。** 每個 pair 快照 8 列，佔一半空間，之後每一列都是重複的資訊。
- **Q2（建議）重複出現的欄位層級原因只記第一次。**
  - 寫列的時機：同一個 `(parser_version, 正規化的欄位路徑, reason)` 第一次出現時寫一列。正規化例如 `$[0].volume.h1` 寫成 `$[*].volume.h1`。
  - 之後出現時：只更新一個可變的彙總表（例如 `parse_quarantine_summary`），記錄第一次與最後一次出現的時間與 observation，以及次數。
  - 照舊每次記錄的：記錄層級的拒絕（`SCHEMA_REJECTED`、`INVALID_ADDRESS`、`UNSUPPORTED_CHAIN`、`NOT_AN_OBJECT`）與 `NOT_REPRESENTABLE`。這些很少見，而且每次都是新資訊。
  - 需要一個新 migration，parser 版本升為 `@3`。
- **Q3 確認 DEX Screener `volume` 與 `priceChange` 的單位。**
  - 確認之後它們就是 `KNOWN`，quarantine 從源頭消失，事件也會多兩組可用的欄位。
  - 需要有證據：文件、或與其他來源對照。不能用猜的。
  - 與 Q2 不互斥。Q2 處理的是之後所有「重複出現的已知原因」。
- **Q4 定期刪除舊的 quarantine 列。** 不建議。這張表是 append-only，刪除需要放寬 trigger，會削弱「證據表不能改」這條規則。

### 事件

- **E1（建議）全部保留。** 它是「當時知道什麼」的紀錄。
- E2 只在內容改變時寫入：價格每次都在變，省不了多少。
- E3 精簡 `Observed` 的 JSON 表示，例如 `KNOWN` 直接存值。實測 payload 從 1,458 B 降到約 690 B，約為事件空間的三分之一；但要改契約並寫轉換器，現在不值得。
- E4 每月分割（partition）：等單一資料表超過約 50 GB 再處理。

### 原始證據

- **R1（建議）全部保留。** 已經以 SHA-256 去重，大的 body 也已經壓縮。

### `jobs` 與 `consumer_inbox`

- **J1（建議）清理舊的列。**
  - 刪除 30 天前已完成（`succeeded`）的 job，以及 30 天前的 `consumer_inbox` 列。
  - `dead` 的 job 保留到操作人處理為止，health 會一直顯示它們。
  - 安全的理由：已完成的 job 不會再被派發；就算同一筆 observation 被重新排入，寫入也是冪等的。
  - 量不大，每天約 4,320 個 job，約 9 MB。所以這件事不急，可以等排程器（FT-03）一起做。
- J2 不清理：每年約 3 GB，可以接受，但表會越來越慢。

`jobs.dedupe_key` 永遠唯一的問題（D4）屬於排程器的設計，在 FT-03 處理，不在這裡。

## 需要操作人決定的事項

1. Morrow 可以使用多少磁碟空間？例如 50、100 或 200 GB。這決定事件是否需要精簡（E3、E4）。
2. 實際上每天運作幾小時？24 小時與每天 8 小時差三倍。
3. 是否採用 Q2，讓 quarantine 只記第一次？
4. 是否採用 J1，在 30 天後清理已完成的 job 與 inbox？

## 決定之後的實作（RV-13b）

- **Q2**：
  - 新 migration：彙總表；`parse_quarantine` 本身不變。
  - Parser 版本升為 `@3`。
  - 測試：同一個原因第二次出現時不再寫列，彙總表的次數正確；記錄層級的拒絕每次都記錄；重跑 parser 得到的事件與之前相同（fact hash 一致）。
- **J1**：
  - 加入 `morrow prune` 指令或 worker 的定期整理。
  - 測試：不會刪除 `queued`、`leased`、`dead` 的 job；不會碰任何 append-only 的表；清理之後重新處理同一筆 observation 不會產生重複的效果。
- RV-13 的完成條件「依決策的保留規則不會刪到 replay 需要的證據」由上面的測試涵蓋。`raw_payloads` 與 `raw_observations` 不受任何保留規則影響。

## 後果

- 採用 Q2：每月的成長約減半。代價是 quarantine 不再能回答「這個原因在每一筆 observation 都出現過嗎」，只能回答「第一次與最後一次在哪裡、共幾次」。需要逐筆的答案時，可以從 raw payload 重跑 parser 得到。
- 不論採用哪個選項，原始證據都完整保留，事件的 point-in-time 時間也不會改變。
