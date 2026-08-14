# Contributing

Thanks for your interest in dsh-vscode! Contributions are welcome.

## Setup

```sh
npm install
npm run build
```

Open the repo in VS Code and press F5 to launch the Extension Development Host.

## Checks before a PR

```sh
npm run typecheck
npm test               # webview render tests + activation test + plugin-manager e2e
npm run test:runtime   # harness runtime smoke test (no API key required)
```

The CI runs all of the above on Windows and Linux. Please run them locally first.

## Packaging

```sh
npm run package   # builds dist/extension.js and produces dsh-vscode-<version>.vsix
```

The vsix bundles the complete harness runtime (`node_modules` + `runtime/` + `presets/`). Publishing to the VS Code Marketplace, Open VSX, or GitHub Releases is documented step by step in [PUBLISHING.md](PUBLISHING.md).

## Pull requests

- Keep changes focused; describe what and why in the PR body.
- UI-visible changes should include or update a webview test in `scripts/test-webview.mjs` where practical.
- Follow the existing code style; the webview renders with `media/chat.html` / `chat.js` / `chat.css` (no framework), and the extension host is plain TypeScript.
- Do not commit credentials, `.env` files, session logs (`.smoke-sessions/`), or build artifacts.

## Reporting bugs

Use the issue templates (Bug Report / Feature Request). Include your VS Code version, OS, and steps to reproduce.

## Security

Report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the project's MIT license.
