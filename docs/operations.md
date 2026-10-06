# 操作說明

日常操作、設定與疑難排解。第一次設定的步驟在 [README](../README.md)。

## 工具鏈

Node.js 與 PostgreSQL 可以用任何方式安裝，只要 `node`、`npm`、`psql` 在 PATH 上，而且 Node 是 `.node-version` 的版本或之後的同一大版本（目前是 24.19.0 以上的 24.x）即可。

沒有管理員權限，或系統已裝的 Node 版本不符、又不想動到其他專案使用的系統 Node 時，用 `scripts\setup-toolchain.ps1`：

- 版本與 SHA-256 固定在 [scripts/toolchain-versions.psd1](../scripts/toolchain-versions.psd1)。Node 的雜湊值與官方 `SHASUMS256.txt` 一致；EDB 沒有為 PostgreSQL 的 zip 發布雜湊檔，所以釘的是第一次下載時觀察到的值。
- 安裝位置 `%LOCALAPPDATA%\Morrow\toolchain`，約 610 MB。
- 不修改 PATH、登錄檔，不安裝服務。每個新的 PowerShell 視窗要 `. .\scripts\dev-env.ps1`。
- `dev-env.ps1` 會沿用 PATH 上已有的 `node`、`psql`。只有當 PATH 上的 Node 版本不符時，才把 toolchain 的 Node 放到 PATH 最前面；這只影響目前的視窗，系統安裝的 Node 不變。
- 移除：刪掉 `%LOCALAPPDATA%\Morrow\toolchain`。

升級版本時，同時更新 `toolchain-versions.psd1` 的版本與雜湊值，以及 `.node-version` 和 `package.json` 的 `engines`。

## 本機 PostgreSQL

```powershell
.\scripts\pg-local.ps1 init     # 第一次：建立 cluster、角色、資料庫，寫入 .env
.\scripts\pg-local.ps1 start
.\scripts\pg-local.ps1 stop
.\scripts\pg-local.ps1 status
```

| 項目 | 位置 |
|---|---|
| 資料 | `%LOCALAPPDATA%\Morrow\pgdata\17` |
| 伺服器日誌 | `%LOCALAPPDATA%\Morrow\pgdata\postgres.log` |
| 超級使用者密碼 | `%LOCALAPPDATA%\Morrow\secrets\postgres-superuser.pw` |
| 應用程式連線字串 | repo 根目錄的 `.env`（已被 git 忽略） |

- 只聽 `127.0.0.1:54317`，使用 scram-sha-256 密碼驗證。
- 以目前使用者身分執行，不是 Windows 服務：登出或關機後要再 `start`。
- 資料放在 repo 之外，所以 `git clean` 不會刪到。
- `.env` 遺失時再跑一次 `init`：它會替 `morrow` 角色換一組新密碼並重寫連線字串，資料不受影響。

**目前沒有備份機制**（M4 的工作）。在那之前，`%LOCALAPPDATA%\Morrow\pgdata` 是唯一的一份資料。

## 啟動與停止

```powershell
npm run migrate    # 有新的 migration 時
npm run api
npm run worker
npm run stop       # 或 npm run stop -- worker
```

- 資料庫有尚未套用的 migration 時，API 與 worker 都拒絕啟動。
- 同一個元件不能同時跑兩份。若前一份已經當掉，新的會立即接手（同一台機器上 pid 已不存在），或最多等 30 秒（心跳逾時）。
- `npm run stop` 在資料庫寫入停止請求，程序在 5 秒內的下一次心跳讀到後乾淨結束。在終端機內按 Ctrl+C 效果相同。
- 強制結束程序（工作管理員、`Stop-Process`）不會遺失資料，但下次啟動會記錄一筆 `UNCLEAN_SHUTDOWN` 缺口。

## 模式

| `MORROW_MODE` | 行為 |
|---|---|
| `OFF`（預設） | API 與 worker 可以啟動並回報狀態，但 worker 不註冊任何會連線到供應商的工作 |
| `RESEARCH` | 允許對供應商發出請求。目前唯一的這類工作是 probe |
| `PAPER` | 目前與 `RESEARCH` 相同；Paper 交易在 M1 之後才有 |
| 其他任何值 | 啟動時被拒絕，exit code 2 |

## 供應商權限探測

```powershell
npm run probe      # 需要 worker 正在執行，且模式不是 OFF
```

對每個功能送出一個最小請求，把結果存進 `provider_probes`，原始回應存進 `raw_observations`。目的是從供應商的實際回應得知免費方案給了什麼，而不是從價目表推測。

| 結果 | 意義 | 處理方式 |
|---|---|---|
| `OK` | 這組憑證可以使用該功能 | — |
| `CREDENTIAL_MISSING` | 沒有設定憑證，請求沒有送出 | 在 `.env` 補上 |
| `ENDPOINT_UNVERIFIED` | 端點尚未對照官方文件確認，請求沒有送出 | 在 `registry.ts` 補上並核對端點 |
| `UNAUTHORIZED` | 憑證被拒絕 | 檢查金鑰；之後再跑一次 probe 以解除封鎖 |
| `PAYMENT_REQUIRED` | 該功能不在免費方案內 | 不要付款。調整設計或標記為不可用 |
| `NOT_FOUND` | 端點路徑可能有誤 | 對照官方文件修正 |
| `TLS_UNTRUSTED` | 連線被攔截，或憑證有問題 | 見下方「網路」 |

Probe 也算額度。來源在 rate limit 退避期間，probe 一樣會被擋下。

OKX 可能用 HTTP 200 回傳錯誤，錯誤放在回應的 `code` 欄位。只有 `code` 是 `"0"`（或 `0`）時才記成 `OK`；其他代碼依 [okx-envelope.ts](../apps/runtime/src/providers/okx-envelope.ts) 分類：`50011` 為 `RATE_LIMITED`，驗證相關（`50103`–`50107`、`50111`–`50114`）與地區封鎖（`50125`、`80001`）為 `UNAUTHORIZED`，`50026` 為 `SERVER_ERROR`，其餘為 `CLIENT_ERROR`。代碼記錄在 `raw_observations.error_class`（例如 `OKX_CODE_50113`），訊息在 `error_detail`。

## 額度

本地上限定義在 [apps/runtime/src/quota/quota-ledger.ts](../apps/runtime/src/quota/quota-ledger.ts)：

| 供應商／額度桶 | 供應商上限 | 警告 | 本地硬性上限 | 依據 |
|---|---|---|---|---|
| OKX Basic | 100,000／月 | 70,000 | 85,000 | 藍圖 |
| OKX Premium | 100,000／月 | 70,000 | 85,000 | 藍圖 |
| Helius credits | 1,000,000／月 | 700,000 | 850,000 | 藍圖只給了供應商上限；警告與硬性上限沿用 OKX 的比例，待量測各端點實際扣點後調整 |

- OKX 各功能扣哪個額度桶，依官方價目頁 [market-api-fee](https://web3.okx.com/onchainos/dev-docs/market/market-api-fee)：hot-token、trades 扣 Basic；memepump、holder、cluster overview／list／top-holders 扣 Premium。
- 重試、手動刷新、probe、回補全部計入，而且請求失敗也不退還。
- 到達硬性上限後請求不會送出，直到下一個計費週期。系統不會付款，也不會換帳號繞過。
- 計費週期目前以 UTC 曆月計算。各供應商實際的重置時間尚未對照帳戶後台確認。
- Jupiter 與 DEX Screener 沒有月額度，只受節流控制（Jupiter 每 2 秒一個請求，DEX Screener 每秒一個）。

## 日誌

API 與 worker 把 JSON 日誌寫到 stdout，一行一筆。Redaction 作用在最後輸出的整行文字上：所有已知的 secret 值（包含資料庫密碼）以及看起來像憑證的片段（URL 內的 `user:password@`、`?api-key=...`）都會被換成 `[REDACTED]`。

## 網路

Worker 需要能直接連到：

- `api.dexscreener.com`
- `api.jup.ag`
- `web3.okx.com`
- `mainnet.helius-rpc.com`
- `api.telegram.org`（M3 起）

**`TLS_UNTRUSTED` 是什麼**：Node 無法驗證對方的 TLS 憑證。在受管理的網路上，最常見的原因是網路設備攔截了連線、換上自己簽發的憑證。系統把這種連線視為不可信，因為經過攔截的價格或鏈上資料無法保證沒有被改動。它不會關閉 TLS 驗證，也不會把攔截者的憑證加入信任。

2026-10-05 在開發時使用的網路上觀察到的情況：

| 主機 | 結果 |
|---|---|
| `api.dexscreener.com`、`api.jup.ag`、`lite-api.jup.ag`、`web3.okx.com` | TLS 憑證由內網位址簽發（遭攔截），回應 HTTP 503 |
| `api.mainnet-beta.solana.com`、`solana.com`、`developers.jup.ag`、`docs.dexscreener.com` | HTTP 503 |
| `api.telegram.org` | 連線被重置 |
| `mainnet.helius-rpc.com`、`registry.npmjs.org`、`nodejs.org`、`github.com` | 正常 |

這是該網路刻意的存取管制。在這種網路上，系統可以建置、測試、啟動，但拿不到任何市場資料。要取得資料，必須在沒有這些限制的網路或機器上執行。不要用代理、VPN 或關閉憑證驗證來繞過。

2026-10-05 起改用另一台開發機。在這台機器上，`api.dexscreener.com`、`api.jup.ag`、`web3.okx.com`、`mainnet.helius-rpc.com`、`api.mainnet-beta.solana.com`、`api.telegram.org`，以及 `developers.jup.ag`、`docs.dexscreener.com`、`www.helius.dev` 都能正常建立 TLS 連線，DEX Screener 的 probe 也實際回了 200。

## 疑難排解

| 現象 | 原因與處理 |
|---|---|
| `Invalid configuration: unrecognised setting(s): MORROW_...` | `.env` 裡有這個版本不認得的變數，通常是打錯字 |
| `Mode "..." is not enabled` | `MORROW_MODE` 不是 `OFF`、`RESEARCH`、`PAPER` |
| `The database has N pending migration(s)` | 執行 `npm run migrate` |
| `A worker session is already running` | 已經有一份在執行；用 `npm run stop -- worker` 停止 |
| `Migration N (...) was changed after it was applied` | 有人改了已套用的 migration。還原該檔案，另外新增一個 migration |
| `npm run probe` 一直顯示 queued | Worker 沒有在執行，或模式是 `OFF` |
| `ECONNREFUSED 127.0.0.1:54317` | 本機 PostgreSQL 沒有啟動：`.\scripts\pg-local.ps1 start` |
| `node` 或 `psql` 找不到 | 這個視窗還沒執行 `. .\scripts\dev-env.ps1` |
| `npm ci` 回報 `EBADENGINE` | PATH 上的 Node 版本不符。執行 `.\scripts\setup-toolchain.ps1`，再 `. .\scripts\dev-env.ps1` |
