# dsh-vscode — DeepSeek Harness for VS Code

在 VS Code 裡面像 Claude Code / Codex / Copilot 一樣使用 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：**左側 Activity Bar 有 DeepSeek Harness 圖示**，點開是**側邊聊天框**，agent 可以讀取、編輯你開啟的專案，並執行指令。

Everything is a plugin：這個 repo 同時包含 **VS Code 擴充功能** 與 **harness 端的 bridge 插件**（`runtime/plugins/vscode-bridge.mjs`），兩者都以「插件」的形式組裝在 DeepSeek Harness 之上。

## 安裝（VS Code 外掛）

1. `npm install && npm run build`
2. `npm run package` → 產出 `dsh-vscode-0.1.0.vsix`
3. 安裝：VS Code 延伸模組面板 → `⋯` → **Install from VSIX...**，或指令 `code --install-extension dsh-vscode-0.1.0.vsix`
4. 左側 Activity Bar 出現 **DeepSeek Harness** 圖示 → 點開側邊聊天框 → 輸入 API key → 開始使用

要發佈到 Marketplace / Open VSX 給所有人安裝，用 `vsce publish`（需先註冊 publisher）。

## 使用者指南：開始使用

1. **安裝**後若視窗原本就開著，先重載：`Ctrl+Shift+P` → `Developer: Reload Window`
2. **開啟一個專案資料夾**（`File` → `Open Folder`）——聊天框需要一個工作區才能操作檔案
3. **打開聊天框**：
   - 右側邊欄出現 **DeepSeek Harness** 圖示（像 Codex/Copilot 的位置）→ 點它；或
   - `Ctrl+Shift+P` → `DeepSeek Harness: Open Chat`；若右側欄沒開，先 `View: Toggle Secondary Side Bar`
4. **輸入 API key**：第一次開啟會顯示設定畫面，貼上 `sk-...` → **Connect**（key 存在 VS Code SecretStorage；也可改用環境變數 `DEEPSEEK_API_KEY` 或工作區 `.env`）
5. **開始對話**：輸入框打字 → Enter 送出；助手回覆串流顯示，工具呼叫（bash / read / write / edit…）以卡片展開

**發送列控制項**（composer bar）：
| 控制項 | 作用 |
|---|---|
| `📎` | 附加檔案（VS Code 選檔對話框），內容會隨訊息送給模型 |
| `model ▾` | 切換模型（讀取 harness 目錄），切換即開新對話 |
| `Workspace ▾`（色標） | 切換權限模式：Read-only（紅）/ Workspace（藍）/ Full access（橘） |
| `0↑ · 0↓` | 本對話 token 用量（輸入/輸出） |
| `history ▾` | 歷史對話（標題列）——點選續接之前的對話 |
| `Send` / `Stop` | 送出 / 忙碌時變 Stop 可中止 |

**其他**：頂部工作區名稱可點擊複製路徑；`DeepSeek Harness: Set API Key` / `Clear API Key` 指令可事後管理 key。

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
│     session/cancel                                │
│   • agent spine（agent-loop、tools、session、…）   │
│   • llm-deepseek、sandbox、bash、fs、compaction    │
└──────────────────────────────────────────────────┘
```

- 擴充功能 spawn `dsh-jsonrpc-agent <runtime/cordis.yml>`（來自 `@deepseek-ai/dsh-sdk-jsonrpc-demo`），透過 `@deepseek-ai/dsh-sdk-client` 以 stdio JSON-RPC 驅動。
- 原廠 SDK server 提供 `initialize` / `session/prompt` / `shutdown` 與完整 `session.event` 串流（token 級增量）；`runtime/plugins/vscode-bridge.mjs` 包住它並**新增 `session/cancel`**，讓 Webview 的 Stop 按鈕能中止進行中的回合。
- 預設 sandbox 模式 `workspace-write`：bash 與檔案編輯被限制在開啟的工作區內；需要升級權限的操作自動拒絕（approval policy `never`）。

## 功能

- **右側邊欄聊天框**（像 Codex / Claude Code / Copilot Chat，使用 VS Code 主題配色）
- **模型選擇**：標題列的 model 下拉選單，從 harness LLM 目錄讀取（deepseek-v4-flash / deepseek-v4-pro…），切換即開新對話
- **歷史聊天**：標題列的 history 下拉選單，列出已持久化的對話（JSONL），點選即可續接
- **API key 設定畫面**在聊天視窗內完成（SecretStorage 儲存），另有 `Set API Key` / `Clear API Key` 指令
- 串流顯示 assistant 回覆（markdown 渲染）、工具呼叫卡片（bash / read / write / edit / grep / glob…）
- Stop 按鈕（`session/cancel`）、New session
- 專案編輯由 harness 的 fs + bash 工具完成，工作區即 sandbox 根目錄

## 需求

- VS Code ≥ 1.90
- Node.js ≥ 20（擴充功能 spawn 本機 Node 跑 harness runtime）
- DeepSeek API key（三種提供方式，見下）

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
npm run test:runtime   # 冒煙測試：啟動 runtime + initialize + prompt + cancel（不需 key）
```

在 VS Code 打開本 repo，按 F5（Run Extension）即可啟動 Extension Development Host 測試。

### 冒煙測試輸出範例（無 key 也能跑）

```
[1/5] initialize OK — deepseek-harness-sdk-runtime 0.0.1
[2/5] prompt OK — messageId …
[3/5] session/cancel OK — {"cancelled":true}
[4/5] session.event stream (12 events): agent/inbox/spliced, turn/start, …
      turn/end reason: {"kind":"error",…"code":"MISSING_CREDENTIAL"}   ← 沒設 key 的預期結果
[5/5] closing runtime…
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
npm run package   # 產出 dsh-vscode-0.1.0.vsix（含完整 harness runtime）
```

- 對 GitHub 開源：repo 加上 `dsh-plugin` topic（社群可發現性，見 [DeepSeek Harness README](https://github.com/deepseek-ai/deepseek-harness)）。
- `runtime/` 本身就是一個可獨立安裝的 harness 插件組合：使用者也可透過 `dsh plugin --profile <name> add github:<你>/dsh-vscode` 把這個組合裝進自己的 profile。

## 已知限制（v1）

- Windows 上 bash 透過 sandbox 的執行環境依賴平台能力，fs 工具的路徑限制在所有平台都生效。
- 無 `ask` 權限流程：需要人工批准的動作直接拒絕（由 sandbox 當安全邊界）。
- 尚未包含 subagent / workflow / MCP 等進階能力（v2 候選）。

## License

MIT
