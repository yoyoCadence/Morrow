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
| **M0** 基礎與契約 | 專案骨架、契約、migration、原始證據、jobs、健康狀態、額度帳本、Paper-only 設定 | — | **完成**（2026-10-05）。端點已核對；供應商權限的實測資料待憑證，見下方 |
| **M1** MINDS＋control slice | 最小供應商 adapter、MINDS 證據、quote model、Paper ledger、risk rejection、replay | M0 | **受阻**：缺少憑證（網路問題在目前的開發機已不存在） |
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
| 保存 provider entitlement probes | 機制達成並已保存結果；端點已核對；**需要憑證的 12 個功能實際權限資料尚未取得** |

最後一項的現況：probe 的流程完整運作，13 個功能的結果都已存入資料庫。在原開發網路上，唯一送得出去的請求（DEX Screener）被網路設備攔截，其餘因為沒有憑證或端點尚未核對而沒有送出。E1.0（2026-10-05）在目前的開發機上補齊並核對了全部端點，重跑 probe：DEX Screener 回 200，其餘 12 個因為沒有憑證而沒有送出。所以 Jupiter、OKX、Helius 的「免費方案實際給了什麼」還沒有答案，要等憑證到位後重跑，這是 E1.0 剩下的部分。

## M1 之前必須解決

1. ~~**網路**~~（目前的開發機已解決，2026-10-05）：原開發網路封鎖了 DEX Screener、Jupiter、OKX Web3、Solana 公開 RPC、Telegram，以及這些供應商的文件網站。目前的開發機可以全部連上，live 驗收要在這台機器上做。這是原網路刻意的存取管制，專案不會嘗試繞過。
2. **憑證**：Jupiter、Helius、OKX 的免費唯讀 API 金鑰；M3 另需 Telegram Bot token 與 chat ID。
3. ~~**端點核對**~~（E1.0 完成這部分，2026-10-05）：[apps/runtime/src/providers/registry.ts](apps/runtime/src/providers/registry.ts) 內 13 個功能都已對照官方文件核對並補齊，OKX 各端點也已依官方價目頁分到 Basic 或 Premium。

## 各里程碑的驗收重點

摘自藍圖，完整內容見藍圖 §4。

- **M1**：MINDS 的 UNKNOWN／DENY 有證據；control portfolio 用真實 quote 完成一次虛擬買賣；ledger 可重建；沒有 sign／broadcast。
- **M2**：未知 mint 可入庫；退榜與被拒絕的資產保留；轉帳不被誤判為賣出；容量與額度限制生效。
- **M3**：有效報告進入 thesis；過期、注入、錯引用的匯入被拒絕；AI 不直接交易；並行 intent 不超額。
- **M4**：三次各 60 分鐘以上的 live session；斷網與重啟可恢復或明示缺口；完整的驗收證據。

Mock fixtures 只算自動化測試證據，不能用來通過 live 驗收。必要的 live 資料拿不到時，該項驗收保持 pending，不降低標準。
