# Roadmap

里程碑的相依關係與完成門檻。設計細節以 [docs/plans/active-plan.md](docs/plans/active-plan.md) 為準，目前進度與證據在 [PROJECT_STATUS.md](PROJECT_STATUS.md)，可派工的任務在 [tasks.md](tasks.md)。

最後更新：2026-10-05

## 授權範圍

- **M0–M4**：已授權，新增服務費目標為 $0。M4 完成後停止。
- **M5–M8**：僅為規劃，尚未取得實作、付款或交易授權。完成 MVP 不會自動開始其中任何一項。

所有實盤額度為 0。沒有簽署金鑰、私鑰或有資金的錢包。

## 狀態總覽

| 里程碑 | 目標 | 相依 | 狀態 |
|---|---|---|---|
| **M0** 基礎與契約 | 專案骨架、契約、migration、原始證據、jobs、健康狀態、額度帳本、Paper-only 設定 | — | **完成**（2026-10-05）。供應商權限的實測資料待補，見下方 |
| **M1** MINDS＋control slice | 最小供應商 adapter、MINDS 證據、quote model、Paper ledger、risk rejection、replay | M0 | **受阻**：開發時使用的網路封鎖供應商，且缺少憑證 |
| **M2** Discovery＋cohort | Jupiter／OKX discovery、warm ranking、holder／cluster 快照、cohort inventory | M1 | 未開始 |
| **M3** Underwriting＋組合決策 | ResearchPacket 匯出匯入、thesis 版本、signals、sizing、reservation、Telegram | M2 | 未開始 |
| **M4** 驗證與 MVP 交付 | Dashboard、session recovery、fault injection、備份還原、基礎 attribution | M3 | 未開始 |
| M5 Production readiness＋Shadow | 常駐部署、獨立 RPC、14 天 shadow | M4＋新授權＋預算 | 未授權 |
| M6 Live canary＋EXIT_ONLY | 隔離 signer、人工核准的小額 round-trip | M5＋錢包與資金批准 | 未授權 |
| M7 Guarded autonomy | 嚴格 gate 下的 entry／add／reduce／exit | M6＋OOS 評估＋人工 promotion | 未授權 |
| M8 Learning | Calibration、ablation、champion/challenger | 足夠的前瞻樣本 | 未授權 |

## M0 完成門檻

| 門檻（藍圖 §4） | 結果 |
|---|---|
| 空資料庫可 migrate | 達成 |
| 啟停成功 | 達成 |
| Secret redaction | 達成 |
| 任何 live mode 啟動均拒絕 | 達成 |
| 保存 provider entitlement probes | 機制達成並已保存結果；**實際權限資料尚未取得** |

最後一項的現況：probe 的流程完整運作，13 個功能的結果都已存入資料庫。但在開發網路上，唯一送得出去的請求（DEX Screener）被網路設備攔截，其餘因為沒有憑證或端點尚未核對而沒有送出。所以「免費方案實際給了什麼」這個問題還沒有答案。這要在可連線的網路上、有了憑證之後重跑，列為 M1 的第一個任務。

## M1 之前必須解決

1. **網路**：開發時使用的網路封鎖了 DEX Screener、Jupiter、OKX Web3、Solana 公開 RPC、Telegram，以及這些供應商的文件網站。M1–M4 的 live 驗收在這個網路上無法進行。需要改在不受限制的網路或機器上執行。這是刻意的存取管制，專案不會嘗試繞過。
2. **憑證**：Jupiter、Helius、OKX 的免費唯讀 API 金鑰；M3 另需 Telegram Bot token 與 chat ID。
3. **端點核對**：[apps/runtime/src/providers/registry.ts](apps/runtime/src/providers/registry.ts) 內所有端點都標記為未核對（`docVerified: false`），其中 8 個功能還沒有端點定義。寫 adapter 之前要對照官方文件逐一確認，包含 OKX 各端點屬於 Basic 還是 Premium 額度。

## 各里程碑的驗收重點

摘自藍圖，完整內容見藍圖 §4。

- **M1**：MINDS 的 UNKNOWN／DENY 有證據；control portfolio 用真實 quote 完成一次虛擬買賣；ledger 可重建；沒有 sign／broadcast。
- **M2**：未知 mint 可入庫；退榜與被拒絕的資產保留；轉帳不被誤判為賣出；容量與額度限制生效。
- **M3**：有效報告進入 thesis；過期、注入、錯引用的匯入被拒絕；AI 不直接交易；並行 intent 不超額。
- **M4**：三次各 60 分鐘以上的 live session；斷網與重啟可恢復或明示缺口；完整的驗收證據。

Mock fixtures 只算自動化測試證據，不能用來通過 live 驗收。必要的 live 資料拿不到時，該項驗收保持 pending，不降低標準。
