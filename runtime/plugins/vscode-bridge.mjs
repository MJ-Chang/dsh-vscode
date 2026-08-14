/**
 * DeepSeek Harness plugin for the dsh-vscode extension.
 *
 * Wraps the stock `@deepseek-ai/dsh-sdk-jsonrpc-server` (which owns
 * initialize / session/prompt / shutdown plus the session.event and
 * session.status notification streams) and adds one method the stock wire
 * lacks:
 *
 *   session/cancel { sessionId } -> { cancelled: boolean }
 *
 * Cancel aborts the addressed agent's active turn (and clears queued work)
 * with a user cancellation cause. The SDK client reaches it through its
 * generic request() method.
 *
 * This file is plain ESM so the harness runtime (a plain Node process) can
 * load it directly from cordis.yml — no build step required.
 *
 * @module dsh-vscode/runtime/plugins/vscode-bridge
 */

import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { HarnessSdkJsonRpcServer } from '@deepseek-ai/dsh-sdk-jsonrpc-server'
import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'vscode-bridge'

// The SDK server drives ctx.agents to create sessions on demand.
export const inject = ['agents']

/**
 * Mount the bridge: serve JSON-RPC on stdio until shutdown or process exit.
 * @param ctx - the booted harness context.
 */
export function apply(ctx) {
  const rootFiber = ctx.root.fiber
  const transport = new JsonRpcLineTransport(process.stdin, process.stdout)
  const server = new HarnessSdkJsonRpcServer(ctx, transport, { maxTokensAsSuccess: false })

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
    if (method === 'session/cancel') {
      const sessionId = params?.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw new Error('session/cancel requires a non-empty sessionId string')
      }
      const agent = ctx.agents.get(SessionId(sessionId))
      if (agent === undefined) return { cancelled: false, reason: 'unknown-session' }
      agent.cancel({ kind: 'user' })
      return { cancelled: true }
    }
    const result = await server.handleRequest(method, params)
    if (method === 'shutdown') {
      // Run after the handler result is written; the task then flushes,
      // disposes the root context, and exits.
      setImmediate(() => { void disposeAndExit() })
    }
    return result
  })

  ctx.effect(() => {
    transport.start()
    return async () => {
      await server.shutdown()
      transport.close()
    }
  }, 'vscode-bridge.serve')
}
