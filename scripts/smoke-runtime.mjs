#!/usr/bin/env node
/**
 * Smoke test for the dsh-vscode harness runtime: spawns the published
 * dsh-jsonrpc-agent bin with runtime/cordis.yml and exercises the wire
 * protocol end to end without VS Code.
 *
 *   initialize → models/list → session/new (with model) → prompt →
 *   session/cancel → session/list → observe session.event stream → close
 *
 * A real model answer requires DEEPSEEK_API_KEY in the environment; without
 * one the run still validates boot, handshake, catalog, history, prompt
 * queueing, cancellation, and event streaming.
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
  // Same launch shape as the extension: preload hides Windows console windows.
  args: ['--require', path.join(root, 'runtime', 'preload-spawn.cjs').replace(/\\/g, '/'), bin, config],
  cwd: workspace,
  env: {
    ...process.env,
    DSH_SESSION_ROOT: sessions,
    DSH_VSCODE_WORKSPACE: workspace,
    DSH_VSCODE_WORKSPACE_WRITE: 'true',
    DSH_VSCODE_EXTENSION_DIR: root,
  },
  shutdownTimeoutMs: 2000,
})

const sessionId = `smoke-${Date.now()}`
const subscription = client.subscribeSessionTree(sessionId)
const events = []
;(async () => {
  for await (const notification of subscription) {
    if (notification.method === 'session.event') {
      events.push(notification.params.event)
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
  console.log(`[1/6] initialize OK — ${init.serverInfo.name} ${init.serverInfo.version}`)
  const catalog = await client.request('models/list', {}, 5000)
  const models = catalog.models ?? []
  console.log(`[2/6] models/list OK — ${models.length} model(s): ${models.map((m) => m.id).join(', ') || '(none)'}`)
  if (models.length === 0) {
    console.error('[FAIL] models/list returned an empty catalog')
    process.exitCode = 1
  }

  const presets = await client.request('presets/list', {}, 5000)
  const presetList = presets.presets ?? []
  console.log(`[3/6] presets/list OK — ${presetList.map((p) => `${p.id}${p.broken ? ` (broken: ${p.broken})` : ''}`).join(', ') || '(none)'}`)
  if (presetList.length === 0) {
    console.error('[FAIL] presets/list returned nothing (agent-presets not mounted?)')
    process.exitCode = 1
  }

  const created = await client.request('session/new', { sessionId, model: 'deepseek-v4-flash', preset: 'minimal' }, 10000)
  console.log(`[3/6] session/new OK (preset=minimal) — ${JSON.stringify(created)}`)

  const messageId = await client.prompt(sessionId, [{ type: 'text', text: 'Say hi.' }])
  console.log(`[4/6] prompt OK — messageId ${messageId}`)

  await sleep(600)
  const cancel = await client.request('session/cancel', { sessionId }, 5000)
  console.log(`[5/6] session/cancel OK — ${JSON.stringify(cancel)}`)

  const history = await client.request('session/list', {}, 5000)
  const sessionsFound = history.sessions ?? []
  console.log(`[6/6] session/list OK — ${sessionsFound.length} persisted session(s)`)
  if (!sessionsFound.some((entry) => entry.sessionId === sessionId)) {
    console.error(`[WARN] session ${sessionId} not listed (persistence may flush later)`)
  }

  const mode = await client.request('session/setMode', { sessionId, mode: 'read-only' }, 5000)
  console.log(`[7/7] session/setMode OK — ${JSON.stringify(mode)}`)

  await sleep(2000)
  const uniqueTypes = [...new Set(events.map((event) => event?.type))]
  console.log(`      session.event stream (${events.length} events): ${uniqueTypes.join(', ') || '(empty)'}`)
  const turnEnd = events.find((event) => event?.type === 'turn/end')
  if (events.length === 0) {
    console.error('[FAIL] no session events received')
    process.exitCode = 1
  } else if (turnEnd === undefined) {
    console.error('[FAIL] turn/end not observed within the window')
    process.exitCode = 1
  } else {
    console.log(`      turn/end reason: ${JSON.stringify(turnEnd.data.reason)}`)
  }
} catch (error) {
  console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  console.log('closing runtime…')
  await client.close()
  const ok = process.exitCode === undefined || process.exitCode === 0
  console.log(ok ? 'SMOKE OK' : 'SMOKE FAILED')
}
