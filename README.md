# Morrow

Event-Driven Investment OS：一套可稽核的投資研究閉環，第一個市場是 Solana meme、micro-cap 與新興敘事代幣。個人自用、單一操作人、全部在本機執行。

**目前只有研究與 Paper 模式。** 這個版本沒有簽署金鑰、沒有錢包、所有實盤額度為 0，要求任何實盤模式都會在啟動時被拒絕。

- 設計基準：[docs/plans/active-plan.md](docs/plans/active-plan.md)
- 進度與驗證證據：[PROJECT_STATUS.md](PROJECT_STATUS.md)
- 里程碑：[ROADMAP.md](ROADMAP.md)
- 任務看板：[tasks.md](tasks.md)
- 協作規範：[AGENTS.md](AGENTS.md)

## 目前能做什麼

M0（基礎與契約）已完成：

- 從空資料庫套用版本化 migration。
- 本機 API（只綁 `127.0.0.1`）與背景 worker 可啟動、可乾淨停止，執行階段與觀測缺口都有紀錄。
- 供應商請求的唯一路徑：來源健康檢查 → 授權 → 額度扣除 → 節流 → 送出 → 原始回應存證。
- 額度帳本、PostgreSQL 工作佇列、append-only 的原始證據與事件表。
- Dashboard：健康狀態（「系統」頁），以及事件、原始觀測與 quarantine 的證據瀏覽（「證據」頁）。

還沒有：任何供應商資料解析、discovery、研究、策略、Paper 交易。這些是 M1–M4。

## 需求

- Node.js 24.19 以上（24.x）
- PostgreSQL 17
- Windows PowerShell 5.1 以上（`scripts/` 內的輔助腳本）

沒有管理員權限也可以：`scripts\setup-toolchain.ps1` 會把固定版本的 Node 與 PostgreSQL 執行檔下載到 `%LOCALAPPDATA%\Morrow\toolchain`，驗證 SHA-256，不改 PATH、不動登錄檔、不安裝服務。刪除該資料夾即完全移除。

## 第一次設定

```powershell
.\scripts\setup-toolchain.ps1     # 已自行安裝 Node 24.19 以上（24.x）與 PostgreSQL 17 可略過
. .\scripts\dev-env.ps1           # 每個新的 PowerShell 視窗都要執行一次
.\scripts\pg-local.ps1 init       # 建立本機資料庫，並把連線字串寫進 .env
npm ci
npm run build
npm run migrate
```

`pg-local.ps1 init` 會建立 `morrow` 與 `morrow_test` 兩個資料庫，以及備份檢查用的 `morrow_restore_check`、`morrow_test_restore_check`（已經 init 過的機器再跑一次 init 即可補上，資料不受影響），密碼隨機產生、只寫入 `.env`，不會顯示在畫面上。資料放在 `%LOCALAPPDATA%\Morrow\pgdata`，在 repo 之外，`git clean` 刪不到。

## 日常使用

```powershell
. .\scripts\dev-env.ps1
.\scripts\pg-local.ps1 start

npm run api        # 終端機一：API 與 dashboard，http://127.0.0.1:8787
npm run worker     # 終端機二：背景 worker

npm run stop       # 請兩個程序乾淨停止（也可以指定 api 或 worker）
.\scripts\pg-local.ps1 stop
```

本機 PostgreSQL 不是 Windows 服務，登出或關機後需要再 `start`。

| 指令 | 用途 |
|---|---|
| `npm run build` | 建置 server 與 dashboard |
| `npm run typecheck` | 型別檢查 |
| `npm run lint` | Biome lint（CI 會執行） |
| `npm run format` | 以 Biome 格式化（尚未強制，見 tasks.md 的 RV-11b） |
| `npm test` | 全部測試（需要測試資料庫、`morrow_test_restore_check`，以及 PATH 上與伺服器同版本或更新的 `pg_dump`／`pg_restore`） |
| `npm run test:unit` | 不需要資料庫的測試 |
| `npm run test:e2e` | 儀表板冒煙測試：在 Chromium 中開啟建置好的儀表板（需要測試資料庫，以及 `npx playwright install --only-shell chromium` 或 `MORROW_E2E_CHROMIUM`） |
| `npm run migrate` | 套用尚未執行的 migration |
| `npm run api` / `npm run worker` | 啟動 API／worker |
| `npm run stop [-- api\|worker]` | 請執行中的程序乾淨停止 |
| `npm run status` | 以 JSON 輸出健康狀態；只有 `ok` 時 exit 0 |
| `npm run backup` | 把資料庫備份到 `MORROW_BACKUP_DIR`，並還原到 `morrow_restore_check` 逐表核對；核對通過才算備份成功（見 [docs/operations.md](docs/operations.md)） |
| `npm run storage` | 各資料表的大小與近 24 小時的成長（會掃描每張表，資料多時要等一下） |
| `npm run probe` | 量測目前金鑰實際可用的供應商功能 |
| `npm run dev:web` | dashboard 開發伺服器（需要 API 同時執行） |

## CI

每個 pull request 與 `main` 的每次 push，都由 GitHub Actions（[.github/workflows/ci.yml](.github/workflows/ci.yml)）執行和本機相同的檢查：

| CI 步驟 | 本機指令 |
|---|---|
| 安裝 | `npm ci`（只依 lockfile，不執行套件的 install script） |
| 型別檢查 | `npm run typecheck` |
| Lint | `npm run lint`（Biome，recommended 規則） |
| 建置 | `npm run build` |
| 全部測試 | `npm test`（CI 使用 PostgreSQL 17 的 service container；備份測試用的 PostgreSQL 17 client 從 PostgreSQL 官方的 apt 套件庫安裝） |
| 儀表板冒煙測試 | `npx playwright install --with-deps --only-shell chromium`，再 `npm run test:e2e` |
| Migration 冒煙測試 | `npm run migrate` 兩次，第二次必須回報已是最新 |

CI 不使用任何 secret：測試從不連到真實供應商，資料庫是用完即丟的容器。Actions 以 commit SHA 釘住版本。CI 只在 Linux 上執行，`scripts/` 的 PowerShell 腳本不在 CI 涵蓋範圍內。

## 設定

全部透過環境變數，範本在 [.env.example](.env.example)。不認得的 `MORROW_*` 變數會讓啟動失敗，所以打錯字不會悄悄退回預設值。

| 變數 | 預設 | 說明 |
|---|---|---|
| `MORROW_MODE` | `OFF` | `OFF`、`RESEARCH` 或 `PAPER`。`OFF` 不會連線到資料供應商 |
| `MORROW_DATABASE_URL` | 必填 | 本機 PostgreSQL |
| `MORROW_TEST_DATABASE_URL` | — | 只給 `npm test` 用，資料庫名稱必須以 `_test` 結尾 |
| `MORROW_BACKUP_DIR` | — | `npm run backup` 的輸出資料夾：絕對路徑、在 repo 之外，最好在另一顆磁碟或同步資料夾 |
| `MORROW_E2E_CHROMIUM` | — | 只給 `npm run test:e2e` 用：已安裝的 Chromium 或 Chrome 執行檔，取代 Playwright 下載的版本 |
| `MORROW_API_PORT` | `8787` | API 連接埠，位址固定為 `127.0.0.1` |
| `MORROW_LOG_LEVEL` | `info` | |
| `MORROW_JUPITER_API_KEY` | — | Jupiter 免費金鑰 |
| `MORROW_HELIUS_API_KEY` | — | Helius 免費金鑰 |
| `MORROW_OKX_API_KEY`、`MORROW_OKX_SECRET_KEY`、`MORROW_OKX_PASSPHRASE` | — | OKX 唯讀 API 憑證，三個要一起設定 |

這些都是唯讀的資料 API 憑證，不是錢包金鑰。

## 網路需求

Worker 需要直接連到 DEX Screener、Jupiter、OKX Web3、Helius，之後還有 Telegram。如果所在網路會攔截或封鎖這些網站，請求會被標成 `TLS_UNTRUSTED` 或 `NETWORK_ERROR`，來源狀態變成 `DOWN`，系統不會嘗試繞過。詳見 [docs/operations.md](docs/operations.md)。

## 結構

```text
apps/
  runtime/     API、worker、資料庫、供應商客戶端、migrations
  web/         Dashboard（React + Vite，建置後由本機 API 提供）
packages/
  core/        與供應商無關的契約與領域邏輯，不做 I/O
scripts/       工具鏈與本機 PostgreSQL 的輔助腳本
docs/          設計基準、架構、契約、操作說明
```

更多細節：[docs/architecture.md](docs/architecture.md)、[docs/contracts.md](docs/contracts.md)、[docs/operations.md](docs/operations.md)。
