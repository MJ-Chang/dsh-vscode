# Changelog

All notable changes to this project are documented here. Versions follow the DeepSeek Harness release train they bundle (`0.1.0-rc.x`); the extension itself uses plain semver.

## [0.2.0] — 2026-08-14

### Added

- Multi-root workspace support: click the workspace name to switch which folder the agent is bound to (single-folder click still copies the path).
- Turn failures now surface in-chat (e.g. a missing API key shows the actual error instead of an empty reply).
- LICENSE, SECURITY.md, THIRD_PARTY_NOTICES.md, CHANGELOG.md, CONTRIBUTING.md, PUBLISHING.md.
- GitHub Actions CI (typecheck, build, unit + runtime smoke tests on Windows and Linux), Dependabot, issue templates.
- Package metadata: icon, keywords, repository/homepage/bugs pointing at the public repo.

### Changed

- Streaming assistant text renders once per animation frame (with a synchronous final flush) instead of re-rendering the whole message on every delta.
- History menu shows conversation titles when the harness title projection is available.

### Fixed

- Switching the workspace folder now rebinds the runtime to the new folder instead of keeping the stale sandbox root.
- Starting/resuming a conversation while a turn is busy now cancels the running turn first (no more orphaned background turns).
- Switching to `Full access` permission mode requires an explicit confirmation.
- Markdown links open in the external browser instead of doing nothing.
- Tool cards are collapsed by default; they auto-expand when a tool errors.
- Smoke test resolves the Node executable portably (no hardcoded Windows path).

## [0.1.0 → 0.1.9]

Initial development releases: right-side chat view, streaming chat, tool cards, model/preset/history menus, permission modes, API-key setup in SecretStorage, harness plugin manager, Windows console-flash fixes, runtime smoke + webview + activation + plugin test suites.
