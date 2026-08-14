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
import { resolveSystemNode } from './node-resolve'
import { generateEffectiveConfig } from './plugins'

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
  | { type: 'usage'; input: number; output: number }

/** One file attached to a user prompt. */
export interface AttachedFile {
  name: string
  content: string
}

export type RuntimeStatus = 'starting' | 'ready' | 'busy' | 'idle' | 'error' | 'stopped'

/** One model from the harness LLM catalog. */
export interface ModelInfo {
  id: string
  name?: string
  description?: string
}

/** One persisted session listed by the runtime. */
export interface SessionInfo {
  sessionId: string
  cwd?: string
  createdAt?: number
  title?: string | null
  parentSession?: string
}

/** One agent preset the runtime roster supplies. */
export interface PresetInfo {
  id: string
  name: string
  description?: string
  trust?: string
  broken?: string
}

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

/**
 * Resolve a console-subsystem Node executable to run the runtime.
 *
 * On Windows this MUST NOT be the extension host's process.execPath
 * (Code.exe, GUI subsystem): a GUI process's console is never inherited by
 * children, so the sandbox runner → pwsh chain would create a visible console
 * window per command (the flashing bug). A real node.exe (console subsystem)
 * holds a console the whole chain can share — exactly how the official
 * harness runs.
 */
export function resolveRuntimeNode(): string {
  return resolveSystemNode()
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
  private pumpGeneration = 0
  private started = false
  private closed = false
  private apiKey: string | undefined
  private turnBusy = false
  private permissionMode: 'read-only' | 'workspace-write' | 'danger-full-access'
  private readonly listeners = new Set<(event: UiEvent) => void>()

  /** @param options - launch and routing configuration. */
  constructor(private readonly options: RuntimeOptions) {
    this.permissionMode = options.workspaceWriteOnly ? 'workspace-write' : 'danger-full-access'
  }

  /** The current sandbox permission mode of the active session. */
  currentMode(): 'read-only' | 'workspace-write' | 'danger-full-access' {
    return this.permissionMode
  }

  /** Switch the active session's sandbox permission mode (live, via the bridge). */
  async setMode(mode: 'read-only' | 'workspace-write' | 'danger-full-access'): Promise<boolean> {
    const client = this.client
    if (client === undefined || this.sessionId === undefined) return false
    try {
      await client.request('session/setMode', { sessionId: this.sessionId, mode }, 5_000)
      this.permissionMode = mode
      this.emit({
        type: 'systemMessage',
        text: `Permission mode: ${mode} (applies from the next tool call)`,
      })
      return true
    } catch {
      return false
    }
  }

  /**
   * Set the API key before start (or before the next start). Injected into the
   * runtime child's environment under {@link RuntimeOptions.apiKeyEnv}.
   * @param apiKey - the key, or `undefined` to rely on the inherited environment.
   */
  setApiKey(apiKey: string | undefined): void {
    this.apiKey = apiKey === undefined ? undefined : apiKey.trim() === '' ? undefined : apiKey.trim()
  }

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
    const configPath = await generateEffectiveConfig({
      extensionPath: this.options.extensionPath,
      storagePath: this.options.storagePath,
    })
    const sessionsRoot = path.join(this.options.storagePath, 'sessions')
    await mkdir(sessionsRoot, { recursive: true })

    this.emit({ type: 'status', status: 'starting' })
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_SESSION_ROOT: sessionsRoot,
      DSH_VSCODE_WORKSPACE: this.options.workspacePath,
      DSH_VSCODE_WORKSPACE_WRITE: String(this.options.workspaceWriteOnly),
      DSH_VSCODE_API_KEY_ENV: this.options.apiKeyEnv,
      DSH_VSCODE_EXTENSION_DIR: this.options.extensionPath,
    }
    // A stored key wins over the inherited environment (never set the var to
    // undefined — child_process would serialize that as the literal "undefined").
    if (this.apiKey !== undefined) {
      childEnv[this.options.apiKeyEnv] = this.apiKey
    }
    const client = new sdk.HarnessClient({
      // A console-subsystem node.exe (not the GUI Code.exe) so the runtime's
      // console is inherited by the sandbox runner → shell chain.
      command: resolveRuntimeNode(),
      // The preload hides the runtime's console window on Windows (the OS
      // creates one for the console-subsystem process at spawn).
      args: [
        '--require',
        path.join(this.options.extensionPath, 'runtime', 'preload-spawn.cjs').replace(/\\/g, '/'),
        bin,
        configPath,
      ],
      cwd: this.options.workspacePath,
      env: childEnv,
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
      const detail = errorMessage(error)
      this.emit({ type: 'status', status: 'error', detail })
      await client.close().catch(() => undefined)
      const hint = /require|pnpm|npm/.test(detail)
        ? ' The runtime node executable could not be launched — make sure Node.js is installed (node --version works in a terminal), then reload the window.'
        : ''
      throw new Error(`failed to start the DeepSeek Harness runtime: ${detail}${hint}`)
    }
    this.client = client
    this.started = true
    this.openSession()
    this.emit({ type: 'status', status: 'idle' })
  }

  /** Queue one user prompt on the current session, optionally with attached files. */
  async prompt(text: string, attachments: AttachedFile[] = []): Promise<void> {
    await this.start()
    const client = this.client
    const sessionId = this.sessionId
    if (client === undefined || sessionId === undefined) {
      throw new Error('DeepSeek Harness runtime is not ready')
    }
    const blocks: ContentBlock[] = [{ type: 'text', text }]
    for (const file of attachments) {
      blocks.push({ type: 'text', text: `\n<attachment name="${file.name}">\n\`\`\`\n${file.content}\n\`\`\`\n</attachment>` })
    }
    this.emit({ type: 'status', status: 'busy' })
    this.turnBusy = true
    await client.prompt(sessionId, blocks)
  }

  /** Cancel the running turn before switching conversations so nothing keeps
   * burning tokens orphaned in the background. */
  private async cancelRunningTurn(): Promise<void> {
    if (!this.turnBusy) return
    this.turnBusy = false
    await this.cancel().catch(() => undefined)
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

  /** The active session id (client-side identity the runtime adopts). */
  currentSessionId(): string | undefined {
    return this.sessionId
  }

  /** The workspace folder this runtime is bound to (used to detect folder switches). */
  workspacePath(): string {
    return this.options.workspacePath
  }

  /** Whether dispose() has run; a disposed runtime must never be reused. */
  isDisposed(): boolean {
    return this.closed
  }

  /** List the LLM catalog the runtime's provider advertises. */
  async listModels(): Promise<ModelInfo[]> {
    await this.start()
    const client = this.client
    if (client === undefined) return []
    try {
      const result = await client.request('models/list', {}, 5_000) as { models?: ModelInfo[] }
      return Array.isArray(result.models) ? result.models : []
    } catch {
      return []
    }
  }

  /** List persisted sessions (history) from the runtime's persistence backend. */
  async listSessions(): Promise<SessionInfo[]> {
    await this.start()
    const client = this.client
    if (client === undefined) return []
    try {
      const result = await client.request('session/list', {}, 5_000) as { sessions?: SessionInfo[] }
      return Array.isArray(result.sessions)
        ? result.sessions.filter((entry) => entry.parentSession === undefined)
        : []
    } catch {
      return []
    }
  }

  /** List agent presets the runtime roster supplies. */
  async listPresets(): Promise<PresetInfo[]> {
    await this.start()
    const client = this.client
    if (client === undefined) return []
    try {
      const result = await client.request('presets/list', {}, 5_000) as { presets?: PresetInfo[] }
      return Array.isArray(result.presets) ? result.presets : []
    } catch {
      return []
    }
  }

  /** Start a new conversation, optionally with a specific model or preset. */
  async newSession(model?: string, preset?: string): Promise<void> {
    await this.start()
    await this.cancelRunningTurn()
    const client = this.client
    if (client === undefined) return
    const sessionId = `vscode-${randomUUID()}`
    await client.request('session/new', {
      sessionId,
      ...(model === undefined ? {} : { model }),
      ...(preset === undefined ? {} : { preset }),
    }, 10_000)
    this.subscription?.close()
    this.subscription = undefined
    this.pumpGeneration++
    this.sessionId = sessionId
    this.subscription = client.subscribeSessionTree(sessionId)
    void this.pumpNotifications()
    this.emit({ type: 'sessionId', sessionId })
    this.emit({ type: 'status', status: 'idle' })
  }

  /** Resume a persisted conversation by session id; returns its replayable transcript. */
  async resumeSession(sessionId: string): Promise<SessionEvent[]> {
    await this.start()
    await this.cancelRunningTurn()
    const client = this.client
    if (client === undefined) return []
    await client.request('session/new', { sessionId }, 10_000)
    this.subscription?.close()
    this.subscription = undefined
    this.pumpGeneration++
    this.sessionId = sessionId
    this.subscription = client.subscribeSessionTree(sessionId)
    void this.pumpNotifications()
    this.emit({ type: 'sessionId', sessionId })
    this.emit({ type: 'status', status: 'idle' })
    try {
      const result = await client.request('session/transcript', { sessionId }, 10_000) as { events?: SessionEvent[] }
      return Array.isArray(result.events) ? result.events : []
    } catch {
      return []
    }
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

  /** Reboot the runtime child (used after plugin install/remove). */
  async restart(): Promise<void> {
    await this.dispose()
    this.closed = false
    this.started = false
    this.emit({ type: 'status', status: 'starting' })
    await this.start()
    this.emit({ type: 'status', status: 'idle' })
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
    const generation = this.pumpGeneration
    if (subscription === undefined) return
    try {
      for await (const notification of subscription) {
        this.handleNotification(notification)
      }
    } catch (error) {
      // Ignore teardown of a superseded subscription (a session switch closed
      // it) and extension shutdown; surface only live runtime failures.
      if (!this.closed && generation === this.pumpGeneration) {
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
      case 'assistant/message': {
        const usage = (event.data as { usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } }).usage
        if (usage !== undefined) {
          const input = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
          this.emit({ type: 'usage', input, output: usage.outputTokens })
        }
        this.emit({ type: 'assistantDone' })
        return
      }
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
      case 'turn/end': {
        this.turnBusy = false
        const reason = (event.data as { reason?: { kind?: string; error?: { message?: string } } }).reason
        if (reason?.kind === 'error') {
          const detail = typeof reason.error?.message === 'string'
            ? reason.error.message
            : 'The turn failed.'
          // Close any open streaming block and surface the failure in-chat so
          // the user is not left staring at an empty assistant reply.
          this.emit({ type: 'assistantDone' })
          this.emit({ type: 'systemMessage', text: `⚠ ${detail}` })
        }
        this.emit({ type: 'status', status: 'idle' })
        return
      }
      default:
        return
    }
  }
}
