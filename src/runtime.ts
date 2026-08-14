/**
 * HarnessRuntime: owns the DeepSeek Harness runtime child process for the
 * dsh-vscode extension.
 *
 * This module is vscode-free so it can be exercised from plain Node. It
 * spawns the published `dsh-jsonrpc-agent` bin with our runtime/cordis.yml,
 * drives it through the TypeScript SDK client (loaded dynamically because it
 * is ESM-only while the extension bundle is CJS), and translates the
 * session.event / session.status notification stream into UI events.
 */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import type { ContentBlock, NotificationSubscription } from '@deepseek-ai/dsh-sdk-client'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

type SdkModule = typeof import('@deepseek-ai/dsh-sdk-client')
type HarnessClient = InstanceType<SdkModule['HarnessClient']>

/** What the webview cares about, normalized from the wire stream. */
export type UiEvent =
  | { type: 'status'; status: RuntimeStatus; detail?: string }
  | { type: 'sessionId'; sessionId: string }
  | { type: 'systemMessage'; text: string }
  | { type: 'assistantDelta'; text: string }
  | { type: 'assistantDone' }
  | { type: 'toolCall'; callId: string; name: string; args: string }
  | { type: 'toolResult'; callId: string; name: string; ok: boolean; summary: string }

export type RuntimeStatus = 'starting' | 'ready' | 'busy' | 'idle' | 'error' | 'stopped'

export interface RuntimeOptions {
  /** Extension install root; runtime/cordis.yml lives here. */
  extensionPath: string
  /** The opened workspace folder (runtime cwd + sandbox root). */
  workspacePath: string
  /** VS Code global storage root; session logs live under it. */
  storagePath: string
  /** Model id for SDK-created agents. */
  model: string
  /** Environment variable holding the API key. */
  apiKeyEnv: string
  /** Confine bash and file edits to the workspace. */
  workspaceWriteOnly: boolean
}

/** Resolve the published runtime bin inside this extension's node_modules. */
export function resolveRuntimeBin(extensionPath: string): string {
  const require = createRequire(path.join(extensionPath, 'package.json'))
  return require.resolve('@deepseek-ai/dsh-sdk-jsonrpc-demo/bin')
}

let sdkPromise: Promise<SdkModule> | undefined
/**
 * Load the ESM SDK client. The extension bundle is CJS and the SDK client is
 * ESM-only; esbuild would convert a literal `import()` into `require()` (which
 * throws ERR_REQUIRE_ESM on the Node 20.x that older VS Code hosts run), so
 * the import goes through Function to keep it a native dynamic import.
 */
function loadSdk(): Promise<SdkModule> {
  sdkPromise ??= new Function('specifier', 'return import(specifier)')('@deepseek-ai/dsh-sdk-client') as Promise<SdkModule>
  return sdkPromise
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Concatenated text of the text blocks in a content array (model-visible). */
function textOf(blocks: readonly { type: string; text?: unknown }[] | undefined): string {
  if (blocks === undefined) return ''
  return blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('')
}

/** One HarnessRuntime, one child process, one session at a time. */
export class HarnessRuntime {
  private client: HarnessClient | undefined
  private subscription: NotificationSubscription | undefined
  private sessionId: string | undefined
  private started = false
  private closed = false
  private readonly listeners = new Set<(event: UiEvent) => void>()

  /** @param options - launch and routing configuration. */
  constructor(private readonly options: RuntimeOptions) {}

  /** Subscribe to UI events; returns an unsubscribe function. */
  subscribe(listener: (event: UiEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(event: UiEvent): void {
    for (const listener of [...this.listeners]) {
      try { listener(event) } catch { /* a UI listener must not kill the runtime loop */ }
    }
  }

  /** Spawn the runtime and perform the initialize handshake. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return
    const sdk = await loadSdk()
    const bin = resolveRuntimeBin(this.options.extensionPath)
    const configPath = path.join(this.options.extensionPath, 'runtime', 'cordis.yml')
    const sessionsRoot = path.join(this.options.storagePath, 'sessions')
    await mkdir(sessionsRoot, { recursive: true })

    this.emit({ type: 'status', status: 'starting' })
    const client = new sdk.HarnessClient({
      command: process.execPath,
      args: [bin, configPath],
      cwd: this.options.workspacePath,
      env: {
        ...process.env,
        DSH_SESSION_ROOT: sessionsRoot,
        DSH_VSCODE_WORKSPACE: this.options.workspacePath,
        DSH_VSCODE_WORKSPACE_WRITE: String(this.options.workspaceWriteOnly),
        DSH_VSCODE_API_KEY_ENV: this.options.apiKeyEnv,
      },
      shutdownTimeoutMs: 1000,
      disposeEofGraceMs: 6000,
      disposeGraceMs: 3000,
    })
    try {
      client.start()
      await client.initialize({
        cwd: this.options.workspacePath,
        provider: 'deepseek-official',
        model: this.options.model,
      })
    } catch (error) {
      this.emit({ type: 'status', status: 'error', detail: errorMessage(error) })
      await client.close().catch(() => undefined)
      throw new Error(`failed to start the DeepSeek Harness runtime: ${errorMessage(error)}`)
    }
    this.client = client
    this.started = true
    this.openSession()
    this.emit({ type: 'status', status: 'idle' })
  }

  /** Queue one user prompt on the current session. */
  async prompt(text: string): Promise<void> {
    await this.start()
    const client = this.client
    const sessionId = this.sessionId
    if (client === undefined || sessionId === undefined) {
      throw new Error('DeepSeek Harness runtime is not ready')
    }
    const message: ContentBlock = { type: 'text', text }
    this.emit({ type: 'status', status: 'busy' })
    await client.prompt(sessionId, [message])
  }

  /** Abort the active turn via the bridge's session/cancel method. */
  async cancel(): Promise<boolean> {
    const client = this.client
    if (client === undefined || this.sessionId === undefined) return false
    try {
      const result = await client.request(
        'session/cancel',
        { sessionId: this.sessionId },
        5_000,
      ) as { cancelled?: boolean }
      return result.cancelled === true
    } catch {
      return false
    }
  }

  /** Drop the current session context and start a fresh one in the same runtime. */
  async newSession(): Promise<void> {
    if (this.client === undefined) return
    this.subscription?.close()
    this.subscription = undefined
    this.openSession()
    this.emit({ type: 'status', status: 'idle' })
  }

  /** The active session id (client-side identity the runtime adopts). */
  currentSessionId(): string | undefined {
    return this.sessionId
  }

  /** Request protocol shutdown and reap the child. Idempotent. */
  async dispose(): Promise<void> {
    this.closed = true
    this.subscription?.close()
    this.subscription = undefined
    const client = this.client
    this.client = undefined
    if (client !== undefined) {
      await client.close().catch(() => undefined)
    }
    this.emit({ type: 'status', status: 'stopped' })
  }

  private openSession(): void {
    if (this.client === undefined) return
    const sessionId = `vscode-${randomUUID()}`
    this.sessionId = sessionId
    this.subscription = this.client.subscribeSessionTree(sessionId)
    void this.pumpNotifications()
    this.emit({ type: 'sessionId', sessionId })
  }

  private async pumpNotifications(): Promise<void> {
    const subscription = this.subscription
    if (subscription === undefined) return
    try {
      for await (const notification of subscription) {
        this.handleNotification(notification)
      }
    } catch (error) {
      if (!this.closed) {
        this.emit({ type: 'status', status: 'error', detail: errorMessage(error) })
      }
    }
  }

  private handleNotification(notification: { method: string; params: Record<string, unknown> }): void {
    const params = notification.params
    if (notification.method === 'session.event') {
      const sessionId = params.sessionId
      if (typeof sessionId !== 'string' || sessionId !== this.sessionId) return
      this.handleSessionEvent(params.event as SessionEvent)
    } else if (notification.method === 'session.status') {
      const sessionId = params.sessionId
      if (typeof sessionId !== 'string' || sessionId !== this.sessionId) return
      const status = params.status === 'running' ? 'busy' : 'idle'
      this.emit({ type: 'status', status })
    }
  }

  private handleSessionEvent(event: SessionEvent): void {
    switch (event.type) {
      case 'user/message': {
        const source = event.data.source
        if (source?.kind !== 'user') {
          this.emit({ type: 'systemMessage', text: textOf(event.data.content) })
        }
        return
      }
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        if (chunk.type === 'text-delta') {
          this.emit({ type: 'assistantDelta', text: chunk.text })
        }
        return
      }
      case 'assistant/message':
        this.emit({ type: 'assistantDone' })
        return
      case 'tool/call':
        this.emit({
          type: 'toolCall',
          callId: String(event.data.callId),
          name: event.data.name,
          args: event.data.arguments,
        })
        return
      case 'tool/result': {
        const block = event.data.message.content[0]
        const summary = textOf(block?.content).slice(0, 400)
        this.emit({
          type: 'toolResult',
          callId: String(block?.toolCallId ?? event.data.message.id),
          name: 'tool',
          ok: block?.isError !== true,
          summary,
        })
        return
      }
      case 'turn/start':
      case 'step/start':
        this.emit({ type: 'status', status: 'busy' })
        return
      case 'turn/end':
        this.emit({ type: 'status', status: 'idle' })
        return
      default:
        return
    }
  }
}
