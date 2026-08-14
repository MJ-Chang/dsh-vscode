/**
 * dsh-vscode extension entry: commands, runtime lifecycle, right-side chat
 * view, and API-key management (VS Code SecretStorage, entered inside the
 * chat view).
 */

import * as vscode from 'vscode'
import { CHAT_VIEW_ID, CHAT_VIEW_ID_SECONDARY, ChatViewProvider } from './chatView'
import { HarnessRuntime } from './runtime'

const API_KEY_SECRET = 'dshVscode.apiKey'

let runtime: HarnessRuntime | undefined
let chatProvider: ChatViewProvider | undefined

/** Lazily create the workspace-bound runtime; warns when no folder is open. */
function getRuntime(context: vscode.ExtensionContext): HarnessRuntime | undefined {
  if (runtime !== undefined) return runtime
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (folder === undefined) {
    void vscode.window.showWarningMessage(
      'DeepSeek Harness: open a workspace folder first, then run the command again.',
    )
    return undefined
  }
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
      if (getRuntime(context) === undefined) return
      void vscode.commands.executeCommand(`${CHAT_VIEW_ID_SECONDARY}.focus`)
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('dshVscode.startRuntime', async () => {
      const target = getRuntime(context)
      if (target === undefined) return
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

  const target = getRuntime(context)
  if (target !== undefined) {
    chatProvider = new ChatViewProvider(context, target)
    const viewOptions = { webviewOptions: { retainContextWhenHidden: true } }
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, chatProvider, viewOptions),
      vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID_SECONDARY, chatProvider, viewOptions),
    )
  }
}

/** Shut the runtime child process down when VS Code exits. */
export function deactivate(): void {
  const target = runtime
  runtime = undefined
  chatProvider = undefined
  void target?.dispose()
}
