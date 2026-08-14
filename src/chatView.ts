/**
 * Sidebar chat view (like Copilot Chat): a WebviewView under the DeepSeek
 * Harness activity-bar container. Renders media/chat.html and routes messages
 * between the webview and the HarnessRuntime.
 */

import { readFileSync } from 'node:fs'
import * as vscode from 'vscode'
import { HarnessRuntime, type UiEvent } from './runtime'

/** The chat view id contributed under `views` in package.json. */
export const CHAT_VIEW_ID = 'dshVscode.chatView'

/**
 * WebviewViewProvider for the sidebar chat. One provider per extension
 * lifetime; the runtime is shared across view resolutions.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  private readonly cleanup = new Set<() => void>()
  private view: vscode.WebviewView | undefined

  /** @param context - the extension context (for resource URIs). */
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly runtime: HarnessRuntime,
    private readonly ensureApiKey: () => Promise<string | undefined>,
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
      (message: { type: string; text?: string }) => { void this.handleMessage(message) },
    )
    this.cleanup.add(unsubscribe)
    this.cleanup.add(() => messageDisposable.dispose())

    webviewView.onDidDispose(() => {
      for (const dispose of this.cleanup) dispose()
      this.cleanup.clear()
      if (this.view === webviewView) this.view = undefined
    })
  }

  private async handleMessage(message: { type: string; text?: string }): Promise<void> {
    const view = this.view
    if (view === undefined) return
    try {
      switch (message.type) {
        case 'ready':
          this.runtime.setApiKey(await this.ensureApiKey())
          await this.runtime.start()
          break
        case 'prompt':
          if (typeof message.text === 'string' && message.text.trim() !== '') {
            await this.runtime.prompt(message.text)
          }
          break
        case 'stop':
          await this.runtime.cancel()
          break
        case 'newSession':
          await this.runtime.newSession()
          await view.webview.postMessage({ type: 'clear' })
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
