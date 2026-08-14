#!/usr/bin/env node
/**
 * Smoke test for the dsh-vscode harness runtime: spawns the published
 * dsh-jsonrpc-agent bin with runtime/cordis.yml and exercises the wire
 * protocol end to end without VS Code.
 *
 *   initialize → prompt → session/cancel → observe session.event stream → close
 *
 * A real model answer requires DEEPSEEK_API_KEY in the environment; without
 * one the run still validates boot, handshake, prompt queueing, cancellation,
 * and event streaming (the model request fails, which surfaces as a turn/end
 * error event instead of an assistant message).
 */
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)
const bin = require.resolve('@deepseek-ai/dsh-sdk-jsonrpc-demo/bin')
const config = path.join(root, 'runtime', 'cordis.yml')
const workspace = path.join(root, '.smoke-workspace')
const sessions = path.join(root, '.smoke-sessions')

await mkdir(workspace, { recursive: true })
await mkdir(sessions, { recursive: true })

const client = new HarnessClient({
  command: process.execPath,
  args: [bin, config],
  cwd: workspace,
  env: {
    ...process.env,
    DSH_SESSION_ROOT: sessions,
    DSH_VSCODE_WORKSPACE: workspace,
    DSH_VSCODE_WORKSPACE_WRITE: 'true',
  },
  shutdownTimeoutMs: 2000,
})

const sessionId = `smoke-${Date.now()}`
const subscription = client.subscribeSessionTree(sessionId)
const events = []
;(async () => {
  for await (const notification of subscription) {
    if (notification.method === 'session.event') {
      const event = notification.params.event
      events.push(event)
    }
  }
})().catch(() => {})

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

try {
  client.start()
  const init = await client.initialize({
    cwd: workspace,
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
  })
  console.log(`[1/5] initialize OK — ${init.serverInfo.name} ${init.serverInfo.version}`)

  const messageId = await client.prompt(sessionId, [{ type: 'text', text: 'Say hi.' }])
  console.log(`[2/5] prompt OK — messageId ${messageId}`)

  await sleep(600)
  const cancel = await client.request('session/cancel', { sessionId }, 5000)
  console.log(`[3/5] session/cancel OK — ${JSON.stringify(cancel)}`)

  await sleep(2500)
  const uniqueTypes = [...new Set(events.map((event) => event?.type))]
  console.log(`[4/5] session.event stream (${events.length} events): ${uniqueTypes.join(', ') || '(empty)'}`)

  const turnEnd = events.find((event) => event?.type === 'turn/end')
  if (events.length === 0) {
    console.error('[FAIL] no session events received')
    process.exitCode = 1
  } else if (turnEnd === undefined) {
    console.error('[WARN] turn/end not observed within the window (a keyless run still emits one)')
    process.exitCode = 1
  } else {
    console.log(`      turn/end reason: ${JSON.stringify(turnEnd.data.reason)}`)
  }
} catch (error) {
  console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  console.log('[5/5] closing runtime…')
  await client.close()
  const ok = process.exitCode === undefined || process.exitCode === 0
  console.log(ok ? 'SMOKE OK' : 'SMOKE FAILED')
}
