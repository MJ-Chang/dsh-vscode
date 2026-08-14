/**
 * Webview panel for the dsh-vscode chat UI: renders media/chat.html and
 * routes messages between the webview and the HarnessRuntime.
 */

import { readFileSync } from 'node:fs'
import * as vscode from 'vscode'
import { HarnessRuntime, type UiEvent } from './runtime'

/** Open (or focus) the chat panel and attach it to the runtime. */
export function openChatPanel(context: vscode.ExtensionContext, runtime: HarnessRuntime): void {
  const panel = vscode.window.createWebviewPanel(
    'dshVscode.chat',
    'DeepSeek Harness',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    },
  )

  panel.webview.html = renderHtml(panel.webview, context.extensionUri)

  const unsubscribe = runtime.subscribe((event: UiEvent) => {
    void panel.webview.postMessage(event)
  })

  panel.webview.onDidReceiveMessage(async (message: { type: string; text?: string }) => {
    try {
      switch (message.type) {
        case 'ready':
          await runtime.start()
          break
        case 'prompt':
          if (typeof message.text === 'string' && message.text.trim() !== '') {
            await runtime.prompt(message.text)
          }
          break
        case 'stop':
          await runtime.cancel()
          break
        case 'newSession':
          await runtime.newSession()
          await panel.webview.postMessage({ type: 'clear' })
          break
        default:
          break
      }
    } catch (error) {
      void panel.webview.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  })

  panel.onDidDispose(() => { unsubscribe() })
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
  // eslint-disable-next-line no-restricted-globals
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
