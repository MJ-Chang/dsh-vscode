# dsh-vscode — DeepSeek Harness for VS Code

[![GitHub Release](https://img.shields.io/github/v/release/kindle1126/dsh-vscode?label=下載)](https://github.com/kindle1126/dsh-vscode/releases/latest)
[![CI](https://github.com/kindle1126/dsh-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/kindle1126/dsh-vscode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A51.90-blue)](https://code.visualstudio.com/)

在 VS Code 右側邊欄使用 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的聊天 agent——像 Claude Code / Codex / Copilot 一樣，直接對話讓它讀取、編輯你的專案並執行指令。Everything is a plugin：整套東西（擴充功能 + harness bridge 插件）都以插件形式組裝在 DeepSeek Harness 之上。

## 安裝

### 方式一：下載安裝檔（最簡單，推薦）

1. 到 [Releases 頁面](https://github.com/kindle1126/dsh-vscode/releases/latest) 下載 `dsh-vscode-0.2.0.vsix`
   （直連：[dsh-vscode-0.2.0.vsix](https://github.com/kindle1126/dsh-vscode/releases/latest/download/dsh-vscode-0.2.0.vsix)）
2. 安裝（任選一種）：
   - VS Code 延伸模組面板 → `⋯` → **Install from VSIX...** → 選剛剛下載的檔案；或
   - `code --install-extension dsh-vscode-0.2.0.vsix`
3. 重載視窗（若原本開著）：`Ctrl+Shift+P` → `Developer: Reload Window`

之後 VS Code 右側邊欄會出現 **DeepSeek Harness** 圖示，點開 → 輸入 API key → 開始使用。

> Marketplace 版本上架後也會出現在延伸模組搜尋中。

### 方式二：自行打包（開發者）

見 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 開始使用

1. **開啟一個專案資料夾**（`File` → `Open Folder`）——聊天框需要一個工作區才能操作檔案
2. **打開聊天框**：點右側邊欄的 **DeepSeek Harness** 圖示；或 `Ctrl+Shift+P` → `DeepSeek Harness: Open Chat`（若右側欄沒開，先 `View: Toggle Secondary Side Bar`）
3. **輸入 API key**：第一次開啟會顯示設定畫面，貼上 `sk-...` → **Connect**。key 存在 VS Code SecretStorage；也可改用環境變數 `DEEPSEEK_API_KEY` 或工作區 `.env`（優先序：SecretStorage → 環境變數 → `.env`）
4. **開始對話**：輸入框打字 → Enter 送出；助手回覆串流顯示，工具呼叫以卡片展開

**發送列控制項**：

| 控制項 | 作用 |
|---|---|
| `📎` | 附加檔案（VS Code 選檔對話框），內容會隨訊息送給模型 |
| `model ▾` | 切換模型（deepseek-v4-flash / deepseek-v4-pro…），切換即開新對話 |
| `Workspace ▾`（色標） | 權限模式：Read-only（紅）/ Workspace（藍）/ Full access（橘，需確認） |
| `0↑ · 0↓` | 本對話 token 用量（輸入/輸出） |
| `history ▾` | 歷史對話（含標題）——點選續接 |
| `preset ▾` | agent preset：`default`（shell + fs + todo）/ `minimal`（僅檔案工具） |
| `Send` / `Stop` | 送出 / 忙碌時變 Stop 可中止 |

**其他**：頂部工作區名稱——多 root 工作區點擊可切換 agent 操作的資料夾，單資料夾點擊複製路徑；`DeepSeek Harness: Set API Key` / `Clear API Key` 指令可事後管理 key。

## 功能

- **右側邊欄聊天框**，使用 VS Code 主題配色
- 串流回覆（每 frame 節流渲染，長回覆不卡頓）；**回合失敗直接顯示錯誤訊息**（例如沒設 API key 不會看到空白回覆）
- **工具呼叫卡片**（bash / read / write / edit / grep / glob…）：預設收合、出錯自動展開
- **模型選擇、歷史續接（含標題）、agent preset、附件**
- **權限模式即時切換**，切到 Full access 需要確認
- **多 root 工作區切換**；切換對話前自動中止進行中的回合（不留背景孤兒）
- **harness 插件管理**：`Install Plugin`（npm / git / 路徑）——「一切皆插件」在嵌入式 runtime 一樣成立
- Windows 上執行指令不會閃 console 視窗

## 需求

- **VS Code ≥ 1.90**
- **DeepSeek API key**（可在聊天框內輸入，或環境變數 / `.env`）
- **Node.js（建議，非必須）**：有裝的話 Windows 上執行指令不會閃視窗；沒裝也能用，但 shell 指令可能閃出 console 視窗
- **npm / pnpm 不需要**：核心功能不碰套件管理器；只有選用的「Install Plugin」功能需要 Node.js 附帶的 npm

## 設定

| Key | 預設 | 說明 |
|---|---|---|
| `dshVscode.model` | `deepseek-v4-flash` | 對話使用的模型 |
| `dshVscode.apiKeyEnv` | `DEEPSEEK_API_KEY` | 存放 API key 的環境變數名稱 |
| `dshVscode.workspaceWriteOnly` | `true` | 限制 agent 只能動工作區；`false` = 完整檔案權限（小心） |

## 它是怎麼運作的

擴充功能背後是一個**真正的 DeepSeek Harness runtime 子程序**（不是包裝 API 的玩具）：`runtime/cordis.yml` 組出完整插件樹——sandbox、session persistence、compaction、token-meter、agent presets、stdio JSON-RPC bridge——所以 harness 的插件架構、沙箱政策與持久化在 VS Code 裡全部保留。

```
VS Code (Webview 聊天框)
        │ postMessage
Extension host (spawn + 事件轉譯)
        │ stdio JSON-RPC
Harness runtime 子程序（sandbox + 檔案/命令工具 + LLM）
```

## 安全

詳見 [SECURITY.md](SECURITY.md)。重點：API key 存 SecretStorage；預設 sandbox 只允許動工作區；Webview 嚴格 CSP + 文字全轉義；「Install Plugin」等同執行任意程式碼，只裝你信任的插件。

## 已知限制（v1）

- 內建 Markdown 渲染支援標題/清單/程式碼塊/粗體/斜體/連結；表格、引用等進階語法尚未支援
- 無 `ask` 權限流程：需要人工批准的動作直接拒絕（由 sandbox 當安全邊界）
- 尚未包含 subagent / workflow / MCP 等進階能力（v2 候選）
- 版本跟隨 DeepSeek Harness 的 `0.1.0-rc.x`（上游為開發者預覽，可能有 breaking changes）

## 開發與貢獻

開發者請見 [CONTRIBUTING.md](CONTRIBUTING.md)；打包、發佈 Marketplace 與 GitHub Release 的步驟見 [PUBLISHING.md](PUBLISHING.md)。

## License

MIT（[LICENSE](LICENSE)）。第三方依賴與授權清單見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
