# dsh-vscode — DeepSeek Harness for VS Code

[![CI](https://github.com/kindle1126/dsh-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/kindle1126/dsh-vscode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A51.90-blue)](https://code.visualstudio.com/)

在 VS Code 裡面像 Claude Code / Codex / Copilot 一樣使用 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：**右側邊欄聊天框**，agent 可以讀取、編輯你開啟的專案，並執行指令。

Everything is a plugin：這個 repo 同時包含 **VS Code 擴充功能**與 **harness 端的 bridge 插件**（`runtime/plugins/vscode-bridge.mjs`），兩者都以「插件」的形式組裝在 DeepSeek Harness 之上。

## 功能

- **右側邊欄聊天框**（像 Codex / Claude Code / Copilot Chat，使用 VS Code 主題配色）
- 串流顯示 assistant 回覆（Markdown 渲染、每 frame 節流，長回覆不卡頓），工具呼叫卡片（bash / read / write / edit / grep / glob…）預設收合、出錯自動展開
- **回合失敗直接顯示在對話裡**（例如沒設 API key 時，不會再看到空白回覆）
- **模型選擇**：標題列 model 下拉選單，從 harness LLM 目錄讀取（deepseek-v4-flash / deepseek-v4-pro…），切換即開新對話
- **歷史聊天**：標題列 history 下拉選單，列出已持久化的對話（含標題），點選即可續接
- **Agent preset**：切換 `default`（shell + fs + todo）或 `minimal`（僅檔案工具）
- **權限模式**：Read-only（紅）/ Workspace（藍）/ Full access（橘）；切到 Full access 需要確認
- **多 root 工作區**：點工作區名稱即可切換 agent 綁定的資料夾；單資料夾時點擊複製路徑
- **API key 設定畫面**在聊天視窗內完成（SecretStorage 儲存），另有 `Set API Key` / `Clear API Key` 指令
- **Stop 按鈕**（`session/cancel`）、New session、附件（📎 選檔，內容隨訊息送出）
- **harness 插件管理**：`Install Plugin`（npm / git / 路徑）——「一切皆插件」在嵌入式 runtime 一樣成立
- token 用量顯示（本對話累計輸入/輸出）
- Windows 上執行指令不會閃 console 視窗（隱藏 console + windowsHide 雙保險）

## 安裝

1. `npm install && npm run build`
2. `npm run package` → 產出 `dsh-vscode-<version>.vsix`
3. 安裝：VS Code 延伸模組面板 → `⋯` → **Install from VSIX...**，或 `code --install-extension dsh-vscode-<version>.vsix`
4. 右側邊欄出現 **DeepSeek Harness** 圖示 → 點開側邊聊天框 → 輸入 API key → 開始使用

## 使用者指南：開始使用

1. **安裝**後若視窗原本就開著，先重載：`Ctrl+Shift+P` → `Developer: Reload Window`
2. **開啟一個專案資料夾**（`File` → `Open Folder`）——聊天框需要一個工作區才能操作檔案
3. **打開聊天框**：
   - 右側邊欄的 **DeepSeek Harness** 圖示（像 Codex/Copilot 的位置）→ 點它；或
   - `Ctrl+Shift+P` → `DeepSeek Harness: Open Chat`；若右側欄沒開，先 `View: Toggle Secondary Side Bar`
4. **輸入 API key**：第一次開啟會顯示設定畫面，貼上 `sk-...` → **Connect**（key 存在 VS Code SecretStorage；也可改用環境變數 `DEEPSEEK_API_KEY` 或工作區 `.env`）
5. **開始對話**：輸入框打字 → Enter 送出；助手回覆串流顯示，工具呼叫以卡片展開

**發送列控制項**（composer bar）：

| 控制項 | 作用 |
|---|---|
| `📎` | 附加檔案（VS Code 選檔對話框），內容會隨訊息送給模型 |
| `model ▾` | 切換模型（讀取 harness 目錄），切換即開新對話 |
| `Workspace ▾`（色標） | 切換權限模式：Read-only（紅）/ Workspace（藍）/ Full access（橘） |
| `0↑ · 0↓` | 本對話 token 用量（輸入/輸出） |
| `history ▾` | 歷史對話（標題列）——點選續接之前的對話 |
| `preset ▾` | 切換 agent preset（預設 `default`） |
| `Send` / `Stop` | 送出 / 忙碌時變 Stop 可中止 |

**其他**：頂部工作區名稱——單資料夾點擊複製路徑、多 root 時點擊切換資料夾；`DeepSeek Harness: Set API Key` / `Clear API Key` 指令可事後管理 key。

## 架構

```
VS Code (Webview chat UI)
        │ postMessage
Extension host (spawn + 事件轉譯)
        │ stdio JSON-RPC (newline-delimited)
┌───────▼─────────────────────────────────────────┐
│ Harness runtime 子程序 (dsh-jsonrpc-agent)        │
│   runtime/cordis.yml 組出的插件樹：                │
│   • vscode-bridge  ← 我們的插件：SDK server +     │
│     session/cancel / setMode / presets / history  │
│   • agent spine（agent-loop、tools、session、…）   │
│   • llm-deepseek、sandbox、bash、fs、compaction    │
└──────────────────────────────────────────────────┘
```

- 擴充功能 spawn `dsh-jsonrpc-agent <runtime/cordis.yml>`（來自 `@deepseek-ai/dsh-sdk-jsonrpc-demo`），透過 `@deepseek-ai/dsh-sdk-client` 以 stdio JSON-RPC 驅動。
- 原廠 SDK server 提供 `initialize` / `session/prompt` / `shutdown` 與完整 `session.event` 串流（token 級增量）；`runtime/plugins/vscode-bridge.mjs` 包住它並新增 `session/cancel`、`session/setMode`、`models/list`、`presets/list`、`session/list`（含標題）、`session/transcript`。
- 預設 sandbox 模式 `workspace-write`：bash 與檔案編輯被限制在開啟的工作區內；需要升級權限的操作自動拒絕（approval policy `never`）。

## 需求

- **VS Code ≥ 1.90**（唯一硬性需求）
- **DeepSeek API key**（設定畫面輸入一次，或環境變數 / `.env`）
- **Node.js（建議，非必須）**：安裝後 Windows 上執行指令不會閃視窗；**沒裝也能用**——自動改用 VS Code 內建的執行環境，但 Windows 上 shell 指令可能閃出 console 視窗
- **npm / pnpm 完全不需要**：核心功能（對話、讀寫檔案、執行指令）不碰套件管理器；只有選用的「Install Plugin」功能需要 Node.js 附帶的 npm

## 設定 API key（三選一）

1. **在 VS Code 內設定（推薦）**：第一次開啟 Chat 面板時會提示輸入 key，存入 VS Code 的 SecretStorage（安全儲存）。也可以隨時用指令列執行：
   - `DeepSeek Harness: Set API Key` — 設定／更新 key
   - `DeepSeek Harness: Clear API Key` — 移除 key
2. **環境變數**：在啟動 VS Code 的環境中設定 `DEEPSEEK_API_KEY`（或透過設定 `dshVscode.apiKeyEnv` 指定其他變數名）。
3. **專案 `.env`**：harness runtime 啟動時會讀取工作區根目錄的 `.env`（`DEEPSEEK_API_KEY=...`）。

優先序：SecretStorage → 環境變數 → 輸入提示。

## 開發

```sh
npm install
npm run build          # esbuild → dist/extension.js
npm run typecheck
npm test               # webview 渲染測試 + 啟動測試 + 插件管理 e2e
npm run test:runtime   # 冒煙測試：啟動 runtime + initialize + prompt + cancel（不需 key）
```

在 VS Code 打開本 repo，按 F5（Run Extension）即可啟動 Extension Development Host 測試。

### 冒煙測試輸出範例（無 key 也能跑）

```
[1/6] initialize OK — deepseek-harness-sdk-runtime 0.0.1
[2/6] models/list OK — 2 model(s): deepseek-v4-flash, deepseek-v4-pro
[3/6] presets/list OK — default, minimal
[3/6] session/new OK (preset=minimal)
[4/6] prompt OK — messageId …
[5/6] session/cancel OK — {"cancelled":true}
[6/6] session/list OK — N persisted session(s)
[7/7] session/setMode OK — {"mode":"read-only"}
      session.event stream (13 events): …
      turn/end reason: {"kind":"error",…"code":"MISSING_CREDENTIAL"}   ← 沒設 key 的預期結果
closing runtime…
SMOKE OK
```

## 設定（VS Code settings）

| Key | 預設 | 說明 |
|---|---|---|
| `dshVscode.model` | `deepseek-v4-flash` | 對話使用的模型 |
| `dshVscode.apiKeyEnv` | `DEEPSEEK_API_KEY` | 存放 API key 的環境變數名稱 |
| `dshVscode.workspaceWriteOnly` | `true` | 限制 agent 只能動工作區；`false` = 完整檔案權限（小心） |

## 打包與發佈

```sh
npm run package   # 產出 dsh-vscode-<version>.vsix（含完整 harness runtime）
```

- CI（`.github/workflows/ci.yml`）在 Windows 與 Linux 上跑 typecheck、build、單元測試與 runtime 冒煙測試。
- 發佈 Marketplace / Open VSX：把 `package.json` 的 `publisher` 換成你註冊的 publisher id，然後 `vsce login <publisher>` + `vsce publish`。
- 開源與推送到 GitHub 的完整步驟見 [PUBLISHING.md](PUBLISHING.md)。

## 安全

詳見 [SECURITY.md](SECURITY.md)。重點：

- API key 存在 VS Code SecretStorage，優先序：SecretStorage → 環境變數 → 工作區 `.env`。
- 預設 sandbox 模式 `workspace-write`：agent 只能動工作區；切到 **Full access** 需要額外確認。
- Webview 使用嚴格 CSP 與 nonce；所有模型/使用者文字都先 HTML escape；Markdown 連結用外部瀏覽器開啟。
- 「Install Plugin」等同執行任意程式碼——只裝你信任的插件。

## 參與貢獻

見 [CONTRIBUTING.md](CONTRIBUTING.md)。Bug 回報請附上 VS Code 版本、OS，以及重現步驟。

## 已知限制（v1）

- 內建 Markdown 渲染支援標題/清單/程式碼塊/粗體/斜體/連結；表格、引用等進階語法尚未支援。
- 無 `ask` 權限流程：需要人工批准的動作直接拒絕（由 sandbox 當安全邊界）。
- Windows 上 bash 透過 sandbox 的執行環境依賴平台能力，fs 工具的路徑限制在所有平台都生效。
- 尚未包含 subagent / workflow / MCP 等進階能力（v2 候選）。
- 版本跟隨 DeepSeek Harness 的 `0.1.0-rc.x`（上游明示會有 breaking changes），升級 runtime 依賴時需重新跑測試。

## License

MIT（見 [LICENSE](LICENSE)）。隨附的第三方依賴與授權清單見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
