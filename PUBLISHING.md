# 發佈（Open Source）指南

本 repo 已整備為「零設定」狀態：LICENSE、SECURITY、CHANGELOG、THIRD_PARTY_NOTICES、CI、issue 範本全部就位，`package.json` 的 `repository` / `homepage` / `bugs` / `icon` / `keywords` 已指向

```
https://github.com/MJ-Chang/dsh-vscode
```

## 1. 推上 GitHub（已完成 ✅）

Repo 已公開：**https://github.com/MJ-Chang/dsh-vscode**（MIT，`main` 分支，CI 自動執行）。之後的日常開發流程：

```sh
git add -A && git commit -m "..."
git push
```

## 2. 發佈到 VS Code Marketplace（可選，之後再做）

Marketplace 帳號無法由別人代辦，這是唯一需要你自己註冊的步驟：

```sh
npm install -g @vscode/vsce
# 到 https://marketplace.visualstudio.com 建立 publisher（例如 MJ-Chang）
# 然後把 package.json 的 "publisher" 換成該 id，再：
vsce login <publisher>
npm run package && vsce publish
```

（可選）Marketplace 商店圖示需要 128×128 PNG：準備好後在 `package.json` 加回 `"icon": "media/icon.png"` 即可；活動列/側欄圖示維持 SVG 不受影響。

不發 Marketplace 也沒關係：使用者可以從 GitHub Releases 下載 `.vsix` 直接安裝（`code --install-extension dsh-vscode-0.2.0.vsix`）。

## 3. 之後每次發版

```sh
# 1) 更新 package.json 版本號
# 2) 更新 CHANGELOG.md（把 unreleased 段落掛上新版本）
# 3) npm ci && npm run build && npm run typecheck && npm test && npm run test:runtime
# 4) npm run package → 上傳 .vsix 到 GitHub Release
```

## 4. 建議的推送前掃描（一次性）

```sh
npx gitleaks@latest git --redact   # 全歷史機密掃描（目前已人工掃過，乾淨）
```

## 5. 上游依賴策略

本擴充功能以 `@deepseek-ai/dsh-*` `0.1.0-rc.6` 為 runtime 基底。上游（deepseek-harness）在 rc 階段會頻繁 breaking change，升級依賴時：

```sh
npm install @deepseek-ai/dsh-sdk-client@latest ...
npm test && npm run test:runtime   # 全綠再發版
```
