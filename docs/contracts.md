# Canonical contracts

契約定義在 [packages/core/src/contracts](../packages/core/src/contracts)，以 zod schema 表達，同時提供執行期驗證與 TypeScript 型別。設計來源是藍圖 §2 的「Canonical contracts」。

## 共通規則

| 規則 | 實作 |
|---|---|
| 資產以 `namespace + network + reference` 識別，不用 symbol | `AssetIdString`，例如 `solana:mainnet-beta:<mint>`。Reference 必須是能解碼成 32 bytes 的 base58 |
| 時間以 UTC 儲存 | `UtcTimestamp`，只接受結尾為 `Z` 的 ISO-8601 |
| `event_time`、`observed_at`、`available_at` 分開 | `TimeSemantics`；`event_time` 可為 null，且必須明確寫出 |
| Token 原始數量用整數字串 | `UIntString` |
| 金額與比例用明確精度的十進位 | `DecimalString`，不含指數、千分位或正號 |
| 缺資料與零分開 | `Observed<T>`，見下 |
| 每筆紀錄可追溯到原始證據 | `Provenance` |
| 契約有版本 | `SCHEMA_VERSION`，目前為 1 |

所有 object schema 都是 strict：多出未知欄位會被拒絕。

## 狀態

藍圖列出 17 個契約。M0 只定義自己會用到的；其餘在用到它們的里程碑加入，避免先寫出沒有程式使用、也沒有測試驗證的 schema。

| 契約 | 狀態 | 位置／預定里程碑 |
|---|---|---|
| Asset（識別） | **已定義** | `asset-id.ts` |
| Asset（decimals、token program、authority、供給快照） | 未定義 | M1 |
| Event | **已定義** | `event.ts` |
| RunSession | **已定義**（檢視用） | `health.ts`；資料表 `run_sessions`、`session_gaps` |
| Wallet、Entity、Cluster | 未定義 | M2 |
| Candidate | 未定義 | M2 |
| ResearchPacket、Thesis、Signal | 未定義 | M3 |
| TradeIntent、RiskDecision、PaperFill | 未定義 | M1 |
| Portfolio／Ledger | 未定義 | M1 |
| Attribution | 未定義 | M1 起（基礎），M4 擴充 |
| Strategy | 未定義 | M3 |
| ExecutionAttempt | 未定義 | M6（未授權，實盤專用） |

另外有幾個藍圖沒有獨立列出、但 M0 需要的契約：`Observed<T>`、`Provenance`、`OperatingMode`、`RequestOutcome`、`SourceState`、`HealthReport`。

## Observed\<T\>

一個值「知道到什麼程度」。五種狀態必須能互相區分，而且各自帶的欄位不同：

| 狀態 | 意義 | 帶的欄位 |
|---|---|---|
| `KNOWN` | 來源可讀、可解讀的目前值 | `value` |
| `STALE` | 曾經知道，但已經太舊 | `value`、`reason` |
| `CONFLICTING` | 來源互相矛盾，我們不挑一個 | `candidates`（至少兩個）、`reason` |
| `UNKNOWN` | 沒有值：缺少、讀不到，或無法在不猜測的情況下解讀 | `reason` |
| `UNSUPPORTED` | 這個來源或這個版本根本無法提供 | `reason` |

### 供應商數值的解讀

[packages/core/src/numeric/decimal.ts](../packages/core/src/numeric/decimal.ts)：

- `null`、`"null"`、`"--"`、`"N/A"`、空字串、`NaN` 等一律是 `UNKNOWN`，不是 0。
- 無法明確判斷為數字的文字（`1,234.5`、`.5`）是 `UNKNOWN (NOT_NUMERIC)`。
- 指數記號會展開成一般十進位，不經過浮點數。
- **比例的單位必須由呼叫端宣告**（`FRACTION` 或 `PERCENT`）。單位尚未確認時宣告 `UNVERIFIED`，結果是 `UNKNOWN (UNIT_UNVERIFIED)`。系統不會從數值大小推測單位：0.5 可能是 50%，也可能是 0.5%，猜錯就差一百倍。
- 宣告為「佔整體的比例」（`bounded`）但換算後落在 [0, 1] 之外的值是 `UNKNOWN (OUT_OF_RANGE)`，通常代表單位弄錯了。

## Event

固定 9 個 domain：`asset`、`market`、`liquidity`、`flow`、`ownership`、`project`、`security`、`system`、`decision`。新的策略特徵應該登記為 signal，不是新增 domain。

| 欄位 | 說明 |
|---|---|
| `dedupe_key` | 識別「同一個事實」。鏈上事實必須包含 signature、instruction path、event ordinal；「同 token 同分鐘」不是合法的去重鍵 |
| `event_id` | 由 `dedupe_key` 決定性導出（RFC 9562 version 8 UUID），所以重播相同輸入會得到相同的 id |
| `subject` | 資產 id，或 `system:`／`provider:`／`portfolio:` 開頭的參照。不接受 symbol |
| `action` | 小寫、以點分隔，例如 `pool.created` |
| `payload_version`、`payload` | 有版本的內容 |
| `event_time` | 可為 null |
| `observed_at`、`available_at` | `available_at` 由資料庫在寫入時指定 |
| `provenance` | 見下 |
| `severity` | `INFO`、`NOTICE`、`WARNING`、`CRITICAL` |
| `confidence` | [0, 1] 的十進位字串，或 null。Null 表示沒有評估過，不是預設為 1 |
| `causation_id`、`correlation_id` | 事件之間的關聯 |

同一個 `dedupe_key` 再次寫入是 no-op。多個來源回報同一個事實時如何保存各自的佐證，M0 尚未處理，留給第一個需要它的 parser（M1）。

## Provenance

| 欄位 | 說明 |
|---|---|
| `provider`、`provider_group` | 讀同一個上游的供應商屬於同一個 group，彼此不算獨立佐證 |
| `parser_version` | 產生這筆紀錄的 parser 版本 |
| `raw_sha256` | 原始回應的雜湊 |
| `evidence_refs` | 至少一筆，例如 `raw_observation:1234` |
| `slot`、`commitment` | 鏈上資料才有；鏈下來源為 null |
| `coverage` | `COMPLETE`、`PARTIAL` 或 `UNKNOWN`，附說明（例如「只有前 100 名持有人」） |

## 運作模式

`OperatingMode` 列出藍圖定義的全部 8 種模式，但只有 `OFF`、`RESEARCH`、`PAPER` 可以啟動。`requireEnabledMode()` 對其他值（包含 `SHADOW`、`LIVE_CANARY`、`EXIT_ONLY`、`GUARDED_AUTO`、`FULL_AUTO`）丟出 `ModeNotEnabledError`。放寬這份清單是後續里程碑中由人做的決定，系統內沒有任何路徑可以自行變更。
