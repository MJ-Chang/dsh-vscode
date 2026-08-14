# Security Policy

## Reporting a vulnerability

Do NOT open a public issue. Send a private report to the maintainers with:

- the affected version(s)
- steps to reproduce
- the impact (what an attacker can do)

We will confirm receipt within 48 hours and aim to ship a fix within 14 days, coordinated with the disclosure.

## Scope

- `src/` (extension host): runtime lifecycle, webview message routing, plugin manager, API-key storage.
- `runtime/` (harness child process): the bridge plugin (`runtime/plugins/vscode-bridge.mjs`), the plugin composition (`runtime/cordis.yml`), and the Windows console preload.
- `media/` (webview UI): chat interface, markdown rendering, menus.

## Threat model & design choices

- **API key**: stored in VS Code SecretStorage (never in settings.json or logs). Precedence: SecretStorage → environment variable → workspace `.env`.
- **Sandbox**: the harness runtime runs with `workspace-write` mode by default — bash and file tools are confined to the opened workspace folder. `Full access` (`danger-full-access`) requires an explicit in-editor confirmation and is meant for trusted projects only.
- **Webview**: strict CSP (`default-src 'none'`, nonce-based scripts). All model/user text is HTML-escaped before rendering. External links are opened through `vscode.env.openExternal` with `http(s)` validation, not navigated inside the webview.
- **Plugin installation**: `Install Plugin` runs npm on a package spec you provide; treat it like running arbitrary code — install only plugins you trust.
- **Windows console**: the runtime child is spawned with a hidden console so shell commands never flash windows; see `runtime/preload-spawn.cjs` and `src/spawn-patch.ts`.

## Known limitations (v1)

- No interactive permission prompts: operations the sandbox policy cannot authorize are rejected automatically (approval policy `never`).
- The webview renders Markdown with a small built-in renderer; all model output is HTML-escaped first, and external links open through `vscode.env.openExternal`.
