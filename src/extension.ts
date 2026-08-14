/**
 * dsh-vscode extension entry: commands, runtime lifecycle, chat panel, and
 * API-key management (VS Code SecretStorage with an env-var fallback).
 */

import * as vscode from 'vscode'
import { openChatPanel } from './panel'
import { HarnessRuntime } from './runtime'

const API_KEY_SECRET = 'dshVscode.apiKey'

let runtime: HarnessRuntime | undefined

/**
 * Resolve the API key the runtime should use, prompting the user on first use.
 * Priority: secret storage → inherited environment variable → user input.
 * @returns the key, or `undefined` when the user dismisses the prompt.
 */
async function ensureApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  const config = vscode.workspace.getConfiguration('dshVscode')
  const apiKeyEnv = config.get<string>('apiKeyEnv', 'DEEPSEEK_API_KEY')

  const stored = await context.secrets.get(API_KEY_SECRET)
  if (stored !== undefined && stored !== '') return stored
  if (process.env[apiKeyEnv] !== undefined && process.env[apiKeyEnv] !== '') return undefined

  const input = await vscode.window.showInputBox({
    title: 'DeepSeek Harness',
    prompt: `Enter your DeepSeek API key (stored in VS Code's secret storage). It will be used for all chat requests.`,
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => value.trim() === '' ? 'The key cannot be empty.' : undefined,
  })
  if (input === undefined || input.trim() === '') return undefined
  await context.secrets.store(API_KEY_SECRET, input.trim())
  return input.trim()
}

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
      if (target !== undefined) openChatPanel(context, target, () => ensureApiKey(context))
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('dshVscode.startRuntime', async () => {
      const target = getRuntime(context)
      if (target === undefined) return
      const apiKey = await ensureApiKey(context)
      target.setApiKey(apiKey)
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
        'DeepSeek Harness: API key saved. Close and reopen the chat panel to apply it to a running runtime.',
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
}

/** Shut the runtime child process down when VS Code exits. */
export function deactivate(): void {
  const target = runtime
  runtime = undefined
  void target?.dispose()
}
