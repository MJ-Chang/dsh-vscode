/**
 * Right-side sidebar chat view (like Codex / Claude Code / Copilot Chat):
 * a WebviewView under the DeepSeek Harness secondary-sidebar container.
 *
 * Renders media/chat.html and routes messages between the webview and the
 * HarnessRuntime. The API key is entered INSIDE the view (a setup screen)
 * and stored in VS Code secret storage — no pop-up input boxes.
 */

import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { HarnessRuntime, type AttachedFile, type UiEvent } from './runtime'

/** Primary (activity bar) view id — used only when the secondary sidebar is unavailable. */
export const CHAT_VIEW_ID = 'dsh-vscode-chat-view'
/** Secondary (right sidebar) view id — the default on modern VS Code. */
export const CHAT_VIEW_ID_SECONDARY = 'dsh-vscode-chat-view-secondary'

const API_KEY_SECRET = 'dshVscode.apiKey'

interface WebviewMessage {
  type: string
  text?: string
  files?: AttachedFile[]
}

/**
 * WebviewViewProvider for the sidebar chat. One provider per extension
 * lifetime, registered for both view ids; the runtime is shared.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  private readonly cleanup = new Set<() => void>()
  private view: vscode.WebviewView | undefined
  private runtime: HarnessRuntime | undefined

  /**
   * @param context - the extension context (resources, secrets).
   * @param runtimeFactory - lazily creates the workspace-bound runtime;
   * returns undefined when no workspace folder is open.
   */
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly runtimeFactory: () => HarnessRuntime | undefined,
  ) {}

  /** Re-run the ready handshake (used when the workspace changes). */
  async refreshState(): Promise<void> {
    const view = this.view
    if (view === undefined) return
    await this.handleMessage({ type: 'ready' })
  }

  /** Reboot the runtime (used after plugin install/remove) and refresh the view. */
  async restartRuntime(): Promise<void> {
    const runtime = this.ensureRuntime()
    if (runtime === undefined) return
    await runtime.restart()
    const view = this.view
    if (view !== undefined) {
      await view.webview.postMessage({ type: 'clear' })
      await this.handleMessage({ type: 'ready' })
    }
  }

  private ensureRuntime(): HarnessRuntime | undefined {
    if (this.runtime === undefined) {
      this.runtime = this.runtimeFactory()
    }
    return this.runtime
  }

  /** Resolve (or re-resolve) the webview view when VS Code shows it. */
  resolveWebviewView(webviewView: vscode.WebviewView): void {
    for (const dispose of this.cleanup) dispose()
    this.cleanup.clear()
    this.view = webviewView
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    }
    webviewView.webview.html = renderHtml(webviewView.webview, this.context.extensionUri)

    const messageDisposable = webviewView.webview.onDidReceiveMessage(
      (message: WebviewMessage) => { void this.handleMessage(message) },
    )
    this.cleanup.add(() => messageDisposable.dispose())
    this.cleanup.add(() => { this.subscribeRuntime(undefined) })

    webviewView.onDidDispose(() => {
      for (const dispose of this.cleanup) dispose()
      this.cleanup.clear()
      if (this.view === webviewView) this.view = undefined
    })
  }

  private runtimeCleanup: (() => void) | undefined

  /** Forward runtime UI events to the current view; re-subscribes on change. */
  private subscribeRuntime(runtime: HarnessRuntime | undefined): void {
    this.runtimeCleanup?.()
    this.runtimeCleanup = undefined
    if (runtime === undefined || this.view === undefined) return
    this.runtimeCleanup = runtime.subscribe((event: UiEvent) => {
      void this.view?.webview.postMessage(event)
    })
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    const view = this.view
    if (view === undefined) return
    try {
      switch (message.type) {
        case 'ready': {
          const config = vscode.workspace.getConfiguration('dshVscode')
          const apiKeyEnv = config.get<string>('apiKeyEnv', 'DEEPSEEK_API_KEY')
          const stored = await this.context.secrets.get(API_KEY_SECRET)
          const configured = (stored !== undefined && stored !== '')
            || (process.env[apiKeyEnv] !== undefined && process.env[apiKeyEnv] !== '')
          const folder = vscode.workspace.workspaceFolders?.[0]
          if (folder === undefined) {
            await view.webview.postMessage({
              type: 'state',
              configured: false,
              noWorkspace: true,
              model: config.get<string>('model', 'deepseek-v4-flash'),
              workspace: '',
              workspacePath: '',
              mode: 'workspace-write',
            })
            break
          }
          const runtime = this.ensureRuntime()
          if (runtime === undefined) break
          this.subscribeRuntime(runtime)
          await view.webview.postMessage({
            type: 'state',
            configured,
            model: config.get<string>('model', 'deepseek-v4-flash'),
            workspace: folder.name,
            workspacePath: folder.uri.fsPath,
            mode: runtime.currentMode(),
          })
          if (configured) {
            runtime.setApiKey(stored ?? undefined)
            await runtime.start()
            const models = await runtime.listModels()
            const presets = await runtime.listPresets()
            await view.webview.postMessage({ type: 'models', models })
            await view.webview.postMessage({ type: 'presets', presets })
          }
          break
        }
        case 'setupKey': {
          const runtime = this.ensureRuntime()
          if (runtime === undefined) {
            await view.webview.postMessage({
              type: 'error',
              message: 'Open a workspace folder first (File → Open Folder), then connect.',
            })
            break
          }
          const key = (message.text ?? '').trim()
          if (key === '') return
          await this.context.secrets.store(API_KEY_SECRET, key)
          runtime.setApiKey(key)
          await runtime.start()
          const models = await runtime.listModels()
          const presets = await runtime.listPresets()
          await view.webview.postMessage({ type: 'configured' })
          await view.webview.postMessage({ type: 'models', models })
          await view.webview.postMessage({ type: 'presets', presets })
          break
        }
        case 'setPreset': {
          const runtime = this.ensureRuntime()
          if (runtime === undefined) break
          if (typeof message.text === 'string' && message.text !== '') {
            await runtime.newSession(undefined, message.text)
            await view.webview.postMessage({ type: 'clear' })
          }
          break
        }
        case 'openSettings':
          void vscode.commands.executeCommand('workbench.action.openSettings', 'dshVscode')
          break
        case 'runCommand':
          if (typeof message.text === 'string' && message.text !== '') {
            void vscode.commands.executeCommand(message.text)
          }
          break
        case 'copyPath':
          if (typeof message.text === 'string' && message.text !== '') {
            await vscode.env.clipboard.writeText(message.text)
            void vscode.window.showInformationMessage('DeepSeek Harness: workspace path copied to clipboard.')
          }
          break
        case 'setMode': {
          const runtime = this.ensureRuntime()
          if (runtime === undefined) break
          if (typeof message.text === 'string' && message.text !== '') {
            await runtime.setMode(message.text as 'read-only' | 'workspace-write' | 'danger-full-access')
          }
          break
        }
        case 'setModel': {
          const runtime = this.ensureRuntime()
          if (runtime === undefined) break
          if (typeof message.text === 'string' && message.text !== '') {
            await runtime.newSession(message.text)
            await view.webview.postMessage({ type: 'clear' })
          }
          break
        }
        case 'newSession': {
          const runtime = this.ensureRuntime()
          if (runtime === undefined) break
          await runtime.newSession()
          await view.webview.postMessage({ type: 'clear' })
          break
        }
        case 'resumeSession': {
          const runtime = this.ensureRuntime()
          if (runtime === undefined) break
          if (typeof message.text === 'string' && message.text !== '') {
            const events = await runtime.resumeSession(message.text)
            await view.webview.postMessage({ type: 'clear' })
            await view.webview.postMessage({ type: 'transcript', events })
          }
          break
        }
        case 'listSessions': {
          const runtime = this.ensureRuntime()
          if (runtime === undefined) break
          const sessions = await runtime.listSessions()
          await view.webview.postMessage({ type: 'sessions', sessions })
          break
        }
        case 'pickFiles': {
          const runtime = this.ensureRuntime()
          if (runtime === undefined) break
          const workspace = vscode.workspace.workspaceFolders?.[0]
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: true,
            canSelectFiles: true,
            canSelectFolders: false,
            openLabel: 'Attach',
            ...(workspace === undefined ? {} : { defaultUri: workspace.uri }),
          })
          if (picked === undefined || picked.length === 0) break
          const files: AttachedFile[] = []
          const MAX_BYTES = 96 * 1024
          for (const uri of picked) {
            try {
              const content = readFileSync(uri.fsPath, 'utf8')
              files.push({
                name: path.basename(uri.fsPath),
                content: content.length > MAX_BYTES ? `${content.slice(0, MAX_BYTES)}\n… [truncated]` : content,
              })
            } catch (error) {
              await view.webview.postMessage({
                type: 'error',
                message: `Could not read ${uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`,
              })
            }
          }
          if (files.length > 0) await view.webview.postMessage({ type: 'attachments', files })
          break
        }
        case 'prompt': {
          const runtime = this.ensureRuntime()
          if (runtime === undefined) {
            await view.webview.postMessage({
              type: 'error',
              message: 'Open a workspace folder first (File → Open Folder), then try again.',
            })
            break
          }
          if (typeof message.text === 'string' && message.text.trim() !== '') {
            await runtime.prompt(message.text, Array.isArray(message.files) ? message.files : [])
          }
          break
        }
        case 'stop': {
          const runtime = this.ensureRuntime()
          if (runtime !== undefined) await runtime.cancel()
          break
        }
        default:
          break
      }
    } catch (error) {
      await view.webview.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

/** Fill the chat.html template with the webview's resource URIs and nonce. */
function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = cryptoNonce()
  const mediaUri = (name: string): string =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', name)).toString()

  const template = readFileSync(
    vscode.Uri.joinPath(extensionUri, 'media', 'chat.html').fsPath,
    'utf8',
  )
  return template
    .replaceAll('{{nonce}}', nonce)
    .replaceAll('{{cssUri}}', mediaUri('chat.css'))
    .replaceAll('{{jsUri}}', mediaUri('chat.js'))
    .replaceAll('{{cspSource}}', webview.cspSource)
}

function cryptoNonce(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
