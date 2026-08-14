/**
 * DeepSeek Harness plugin for the dsh-vscode extension.
 *
 * A complete stdio JSON-RPC server tailored to the VS Code chat UI. The stock
 * `dsh-sdk-jsonrpc-server` is deliberately not used: this bridge adds the
 * capabilities the IDE needs that the stock wire lacks — model selection and
 * persisted-session history:
 *
 *   initialize          {cwd, provider, model}      → server identity
 *   models/list         {}                          → [{id, name, description?}]
 *   session/new         {sessionId, model?}         → creates (or resumes, when
 *                                                     persisted) the agent
 *   session/prompt      {sessionId, contentBlocks}  → {messageId} (enqueue)
 *   session/cancel      {sessionId}                 → {cancelled}
 *   session/list        {}                          → persisted SessionHeader[]
 *   shutdown            {}                          → dispose + exit 0
 *
 * Notifications (server→client): session.event (full durable stream),
 * session.status (agent running/idle).
 *
 * stdout carries JSON-RPC only — no stdout logger may load.
 *
 * @module dsh-vscode/runtime/plugins/vscode-bridge
 */

import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'

export const name = 'vscode-bridge'

// The agent factory creates sessions; the persistence seam lists history.
export const inject = ['agents', 'sessions', 'sessionPersistence']

/**
 * Mount the bridge: serve JSON-RPC on stdio until shutdown or process exit.
 * @param ctx - the booted harness context.
 */
export function apply(ctx) {
  const rootFiber = ctx.root.fiber
  const transport = new JsonRpcLineTransport(process.stdin, process.stdout)

  // Route defaults; initialize may override, and session/new may pick a model.
  let cwd = process.cwd()
  let provider = 'deepseek-official'
  let model = 'deepseek-v4-flash'
  let llmFiber

  /** sessionId → live agent handle (created on demand or by session/new). */
  const agents = new Map()
  const pending = new Map()

  // ---- notification wiring (mirrors the stock server) ----

  const disposers = [
    ctx.on('session/event', (session, event) => {
      transport.notify('session.event', { sessionId: String(session.id), event })
    }),
    ctx.on('agent/status', ({ agent, status }) => {
      transport.notify('session.status', { sessionId: String(agent.session.id), status })
    }),
  ]

  // ---- session lifecycle ----

  async function createAgent(sessionId, preferredModel) {
    const handle = await ctx.agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd },
      agentOptions: {
        provider,
        model: preferredModel ?? model,
      },
    })
    return handle
  }

  /** Get the live agent for a session, creating it (or resuming a persisted
   *  log under the same id) on first use. */
  async function getOrCreateSession(sessionId, preferredModel) {
    const existing = agents.get(sessionId)
    if (existing !== undefined) return existing
    const queued = pending.get(sessionId)
    if (queued !== undefined) return queued
    const creation = createAgent(sessionId, preferredModel)
    pending.set(sessionId, creation)
    try {
      const handle = await creation
      agents.set(sessionId, handle)
      return handle
    } finally {
      pending.delete(sessionId)
    }
  }

  // ---- request handlers ----

  async function initialize(params) {
    cwd = params.cwd === undefined ? process.cwd() : String(params.cwd)
    provider = params.provider ?? 'deepseek-official'
    model = params.model ?? 'deepseek-v4-flash'
    const llm = ctx.get('llm')
    const hasAdapter = llm?.listProviders().some((entry) => entry.id === provider) ?? false
    if (!hasAdapter) {
      if (provider !== 'deepseek-official') {
        throw new Error(`no adapter registered for provider "${provider}"`)
      }
      llmFiber = await ctx.plugin(LlmDeepSeek, {})
    }
    return { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } }
  }

  async function listModels() {
    const llm = ctx.get('llm')
    const catalog = llm === undefined ? [] : await llm.listModels(provider)
    return { models: catalog }
  }

  async function createSession(params) {
    const sessionId = String(params.sessionId)
    if (sessionId === '') throw new Error('session/new requires a non-empty sessionId')
    const preferredModel = typeof params.model === 'string' && params.model !== ''
      ? params.model
      : undefined
    await getOrCreateSession(sessionId, preferredModel)
    return { sessionId }
  }

  async function prompt(params) {
    const sessionId = String(params.sessionId)
    if (sessionId === '') throw new Error('session/prompt requires a non-empty sessionId')
    const handle = await getOrCreateSession(sessionId)
    // Validate against the live registry: a loop-only reload disposes agents
    // while this record survives (as the stock server does).
    if (ctx.agents.get(handle.agent.id) !== handle.agent) {
      agents.delete(sessionId)
      throw new Error(`session agent was disposed outside the server: ${sessionId}`)
    }
    const message = createUserMessage({ content: params.contentBlocks, source: { kind: 'user' } })
    handle.agent.followup(message)
    return { messageId: message.id }
  }

  async function cancel(params) {
    const sessionId = String(params.sessionId)
    if (sessionId === '') throw new Error('session/cancel requires a non-empty sessionId')
    const agent = ctx.agents.get(SessionId(sessionId))
    if (agent === undefined) return { cancelled: false, reason: 'unknown-session' }
    agent.cancel({ kind: 'user' })
    return { cancelled: true }
  }

  async function setMode(params) {
    const sessionId = String(params.sessionId)
    const mode = String(params.mode)
    const allowed = ['read-only', 'workspace-write', 'danger-full-access']
    if (!allowed.includes(mode)) {
      throw new Error(`session/setMode: invalid mode "${mode}" (expected ${allowed.join(' | ')})`)
    }
    const agent = ctx.agents.get(SessionId(sessionId))
    if (agent === undefined) throw new Error(`session/setMode: unknown session ${sessionId}`)
    setSandboxMode(agent.session, mode)
    return { mode }
  }

  async function listSessions() {
    const headers = await ctx.sessionPersistence.list()
    return {
      sessions: headers.map((header) => ({
        sessionId: String(header.id),
        cwd: header.cwd,
        createdAt: header.createdAt,
        parentSession: header.parentSession === undefined ? undefined : String(header.parentSession),
      })),
    }
  }

  async function shutdown() {
    const pendingCreations = [...pending.values()]
    await Promise.allSettled(pendingCreations)
    pending.clear()
    const records = [...agents.values()]
    agents.clear()
    const failures = []
    while (disposers.length > 0) {
      try { disposers.pop()() } catch (error) { failures.push(error) }
    }
    const results = await Promise.allSettled([
      ...records.map((handle) => Promise.resolve().then(() => handle.dispose())),
      ...(llmFiber === undefined ? [] : [Promise.resolve().then(() => llmFiber.dispose())]),
    ])
    llmFiber = undefined
    failures.push(...results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'vscode-bridge teardown failed')
    return {}
  }

  // Protocol shutdown owns the whole runtime process: flush the response,
  // dispose the root context to quiescence, then exit 0. One shared task so
  // racing shutdown requests cannot dispose twice.
  let exitTask
  const disposeAndExit = () => {
    exitTask ??= (async () => {
      await Promise.allSettled([Promise.resolve().then(() => transport.flush())])
      await Promise.allSettled([Promise.resolve().then(() => rootFiber.dispose())])
      process.exit(0)
    })()
    return exitTask
  }

  transport.onRequest(async (method, params) => {
    let result
    switch (method) {
      case 'initialize': result = await initialize(params ?? {}); break
      case 'models/list': result = await listModels(); break
      case 'session/new': result = await createSession(params ?? {}); break
      case 'session/prompt': result = await prompt(params ?? {}); break
      case 'session/cancel': result = await cancel(params ?? {}); break
      case 'session/setMode': result = await setMode(params ?? {}); break
      case 'session/list': result = await listSessions(); break
      case 'shutdown': result = await shutdown(); break
      default: throw new Error(`unknown DeepSeek Harness SDK runtime method: ${method}`)
    }
    if (method === 'shutdown') {
      setImmediate(() => { void disposeAndExit() })
    }
    return result
  })

  ctx.effect(() => {
    transport.start()
    return async () => {
      await shutdown().catch(() => undefined)
      transport.close()
    }
  }, 'vscode-bridge.serve')
}
