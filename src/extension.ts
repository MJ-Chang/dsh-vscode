/**
 * dsh-vscode extension entry: commands, runtime lifecycle, right-side chat
 * view, and API-key management (VS Code SecretStorage, entered inside the
 * chat view). The view is registered unconditionally so a user who opens it
 * without a workspace folder gets a clear message instead of a broken view.
 */

import * as vscode from 'vscode'
import { CHAT_VIEW_ID, CHAT_VIEW_ID_SECONDARY, ChatViewProvider } from './chatView'
import { installPlugin, listPlugins, removePlugin, type PluginPaths } from './plugins'
import { HarnessRuntime } from './runtime'
import { applyWindowsSpawnPatch } from './spawn-patch'

// Hide console windows for every child spawn on Windows (the extension host
// is a GUI process; the SDK client's runtime spawn would otherwise flash).
applyWindowsSpawnPatch()

const API_KEY_SECRET = 'dshVscode.apiKey'

let runtime: HarnessRuntime | undefined
let chatProvider: ChatViewProvider | undefined

/** Plugin-manager paths derived from the extension context. */
function pluginPaths(context: vscode.ExtensionContext): PluginPaths {
  return {
    extensionPath: context.extensionPath,
    storagePath: context.globalStorageUri.fsPath,
  }
}

/** Create the workspace-bound runtime; undefined when no folder is open. */
function createRuntime(context: vscode.ExtensionContext): HarnessRuntime | undefined {
  if (runtime !== undefined) return runtime
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (folder === undefined) return undefined
  const config = vscode.workspace.getConfiguration('dshVscode')
  runtime = new HarnessRuntime({
    extensionPath: context.extensionPath,
    workspacePath: folder.uri.fsPath,
    storagePath: context.globalStorageUri.fsPath,
    model: config.get<string>('model', 'deepseek-v4-flash'),
    apiKeyEnv: config.get<string>('apiKeyEnv', 'DEEPSEEK_API_KEY'),
    workspaceWriteOnly: config.get<boolean>('workspaceWriteOnly', true),
  })
  return runtime
}

/** Activate the extension: register the right-side chat view and commands. */
export function activate(context: vscode.ExtensionContext): void {
  // Modern VS Code has the secondary side bar; the activity-bar fallback
  // container is gated behind the inverse context key (see package.json).
  void vscode.commands.executeCommand(
    'setContext',
    'dshVscode.doesNotSupportSecondarySidebar',
    false,
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('dshVscode.openChat', () => {
      void vscode.commands.executeCommand(`${CHAT_VIEW_ID_SECONDARY}.focus`)
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('dshVscode.startRuntime', async () => {
      const target = createRuntime(context)
      if (target === undefined) {
        void vscode.window.showWarningMessage(
          'DeepSeek Harness: open a workspace folder first, then run the command again.',
        )
        return
      }
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Starting DeepSeek Harness runtime',
        },
        async () => { await target.start() },
      )
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('dshVscode.setApiKey', async () => {
      const input = await vscode.window.showInputBox({
        title: 'DeepSeek Harness',
        prompt: 'Enter your DeepSeek API key. It is stored in VS Code secret storage.',
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) => value.trim() === '' ? 'The key cannot be empty.' : undefined,
      })
      if (input === undefined || input.trim() === '') return
      await context.secrets.store(API_KEY_SECRET, input.trim())
      runtime?.setApiKey(input.trim())
      void vscode.window.showInformationMessage(
        'DeepSeek Harness: API key saved. It is used from the next chat message on.',
      )
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('dshVscode.clearApiKey', async () => {
      await context.secrets.delete(API_KEY_SECRET)
      runtime?.setApiKey(undefined)
      void vscode.window.showInformationMessage('DeepSeek Harness: API key removed.')
    }),
  )

  // ---- harness plugin management (the embedded runtime is plugin-composed) ----

  context.subscriptions.push(
    vscode.commands.registerCommand('dshVscode.installPlugin', async () => {
      const spec = await vscode.window.showInputBox({
        title: 'DeepSeek Harness: Install Plugin',
        prompt: 'npm package name, git spec (github:user/repo), or a local path. Example: dsh-hello-plugin',
        ignoreFocusOut: true,
        validateInput: (value) => value.trim() === '' ? 'Enter a package spec.' : undefined,
      })
      if (spec === undefined || spec.trim() === '') return
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Installing ${spec}…` },
          async () => { await installPlugin(spec.trim(), pluginPaths(context)) },
        )
        await chatProvider?.restartRuntime()
        const installed = await listPlugins(pluginPaths(context))
        void vscode.window.showInformationMessage(
          `DeepSeek Harness: plugin installed. Active plugins: ${installed.join(', ') || '(none)'}`,
        )
      } catch (error) {
        void vscode.window.showErrorMessage(
          `DeepSeek Harness: install failed — ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('dshVscode.removePlugin', async () => {
      const installed = await listPlugins(pluginPaths(context))
      if (installed.length === 0) {
        void vscode.window.showInformationMessage('DeepSeek Harness: no plugins installed.')
        return
      }
      const picked = await vscode.window.showQuickPick(installed, {
        title: 'DeepSeek Harness: Remove Plugin',
        placeHolder: 'Select a plugin to remove',
      })
      if (picked === undefined) return
      try {
        await removePlugin(picked, pluginPaths(context))
        await chatProvider?.restartRuntime()
        void vscode.window.showInformationMessage(`DeepSeek Harness: ${picked} removed.`)
      } catch (error) {
        void vscode.window.showErrorMessage(
          `DeepSeek Harness: remove failed — ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('dshVscode.listPlugins', async () => {
      const installed = await listPlugins(pluginPaths(context))
      if (installed.length === 0) {
        void vscode.window.showInformationMessage(
          'DeepSeek Harness: no user plugins installed. Use "DeepSeek Harness: Install Plugin" to add one.',
        )
        return
      }
      const picked = await vscode.window.showQuickPick(installed, {
        title: 'DeepSeek Harness: Installed Plugins',
        placeHolder: 'Installed harness plugins',
      })
      void picked
    }),
  )

  // The provider is always registered; the runtime is created lazily on first
  // use so a missing workspace shows an actionable message, not a dead view.
  chatProvider = new ChatViewProvider(context, () => createRuntime(context))
  const viewOptions = { webviewOptions: { retainContextWhenHidden: true } }
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, chatProvider, viewOptions),
    vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID_SECONDARY, chatProvider, viewOptions),
  )

  // When the user opens a folder after the view was created, refresh it so
  // the chat becomes usable without a reload.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void chatProvider?.refreshState() }),
  )
}

/** Shut the runtime child process down when VS Code exits. */
export function deactivate(): void {
  const target = runtime
  runtime = undefined
  chatProvider = undefined
  void target?.dispose()
}
