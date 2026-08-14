/**
 * dsh-vscode extension entry: commands, runtime lifecycle, chat panel.
 */

import * as vscode from 'vscode'
import { openChatPanel } from './panel'
import { HarnessRuntime } from './runtime'

let runtime: HarnessRuntime | undefined

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

/** Activate the extension: register commands and wire the panel. */
export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('dshVscode.openChat', () => {
      const target = getRuntime(context)
      if (target !== undefined) openChatPanel(context, target)
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
}

/** Shut the runtime child process down when VS Code exits. */
export function deactivate(): void {
  const target = runtime
  runtime = undefined
  void target?.dispose()
}
