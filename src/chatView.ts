/**
 * Right-side sidebar chat view (like Codex / Claude Code / Copilot Chat):
 * a WebviewView under the DeepSeek Harness secondary-sidebar container.
 *
 * Renders media/chat.html and routes messages between the webview and the
 * HarnessRuntime. The API key is entered INSIDE the view (a setup screen)
 * and stored in VS Code secret storage — no pop-up input boxes.
 */

import { readFileSync } from 'node:fs'
import * as vscode from 'vscode'
import { HarnessRuntime, type UiEvent } from './runtime'

/** Primary (activity bar) view id — used only when the secondary sidebar is unavailable. */
export const CHAT_VIEW_ID = 'dsh-vscode-chat-view'
/** Secondary (right sidebar) view id — the default on modern VS Code. */
export const CHAT_VIEW_ID_SECONDARY = 'dsh-vscode-chat-view-secondary'

const API_KEY_SECRET = 'dshVscode.apiKey'

interface WebviewMessage {
  type: string
  text?: string
}

/**
 * WebviewViewProvider for the sidebar chat. One provider per extension
 * lifetime, registered for both view ids; the runtime is shared.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  private readonly cleanup = new Set<() => void>()
  private view: vscode.WebviewView | undefined

  /** @param context - the extension context (resources, secrets). */
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly runtime: HarnessRuntime,
  ) {}

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

    const unsubscribe = this.runtime.subscribe((event: UiEvent) => {
      void webviewView.webview.postMessage(event)
    })
    const messageDisposable = webviewView.webview.onDidReceiveMessage(
      (message: WebviewMessage) => { void this.handleMessage(message) },
    )
    this.cleanup.add(unsubscribe)
    this.cleanup.add(() => messageDisposable.dispose())

    webviewView.onDidDispose(() => {
      for (const dispose of this.cleanup) dispose()
      this.cleanup.clear()
      if (this.view === webviewView) this.view = undefined
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
          await view.webview.postMessage({
            type: 'state',
            configured,
            model: config.get<string>('model', 'deepseek-v4-flash'),
            workspace: vscode.workspace.workspaceFolders?.[0]?.name ?? '',
          })
          if (configured) {
            this.runtime.setApiKey(stored ?? undefined)
            await this.runtime.start()
            const models = await this.runtime.listModels()
            await view.webview.postMessage({ type: 'models', models })
          }
          break
        }
        case 'setupKey': {
          const key = (message.text ?? '').trim()
          if (key === '') return
          await this.context.secrets.store(API_KEY_SECRET, key)
          this.runtime.setApiKey(key)
          await this.runtime.start()
          const models = await this.runtime.listModels()
          await view.webview.postMessage({ type: 'configured' })
          await view.webview.postMessage({ type: 'models', models })
          break
        }
        case 'setModel':
          if (typeof message.text === 'string' && message.text !== '') {
            await this.runtime.newSession(message.text)
            await view.webview.postMessage({ type: 'clear' })
          }
          break
        case 'newSession':
          await this.runtime.newSession()
          await view.webview.postMessage({ type: 'clear' })
          break
        case 'resumeSession':
          if (typeof message.text === 'string' && message.text !== '') {
            await this.runtime.resumeSession(message.text)
            await view.webview.postMessage({ type: 'clear' })
            await view.webview.postMessage({ type: 'systemMessage', text: 'Resumed a previous conversation.' })
          }
          break
        case 'listSessions': {
          const sessions = await this.runtime.listSessions()
          await view.webview.postMessage({ type: 'sessions', sessions })
          break
        }
        case 'prompt':
          if (typeof message.text === 'string' && message.text.trim() !== '') {
            await this.runtime.prompt(message.text)
          }
          break
        case 'stop':
          await this.runtime.cancel()
          break
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
