#!/usr/bin/env node
/**
 * Flash diagnosis in the REAL runtime mode: boot the runtime exactly like the
 * extension host does — Code.exe + ELECTRON_RUN_AS_NODE + the hidden-console
 * preload — then spawn a probe child through ctx.subprocess (the same path the
 * shell executor uses) and report the child's console window state.
 *
 *   visible:false → the child shares the hidden console → no flash expected
 *   visible:true  → the child created a visible console → flash reproduced
 */
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)
// The runtime is now launched with a CONSOLE-subsystem node.exe (not the GUI
// Code.exe) so its console is inherited by the sandbox runner → shell chain.
const runtimeNode = 'C:\\Program Files\\nodejs\\node.exe'
const preload = path.join(root, 'runtime', 'preload-spawn.cjs').replace(/\\/g, '/')
const bin = require.resolve('@deepseek-ai/dsh-sdk-jsonrpc-demo/bin')

// compile plugins.ts for the effective config
const buildDir = path.join(root, '.test-build')
await mkdir(buildDir, { recursive: true })
await build({
  entryPoints: [path.join(root, 'src/plugins.ts')],
  bundle: false,
  format: 'esm',
  platform: 'node',
  outfile: path.join(buildDir, 'plugins.mjs'),
  logLevel: 'silent',
})
const plugins = await import(pathToFileURL(path.join(buildDir, 'plugins.mjs')).href)
const storagePath = path.join(root, '.test-storage')
await rm(storagePath, { recursive: true, force: true })
const configPath = await plugins.generateEffectiveConfig({ extensionPath: root, storagePath })

const workspace = path.join(root, '.smoke-workspace')
await mkdir(workspace, { recursive: true })

const client = new HarnessClient({
  command: runtimeNode,
  args: ['--require', preload, bin, configPath],
  cwd: workspace,
  env: {
    ...process.env,
    DSH_SESSION_ROOT: path.join(storagePath, 'sessions'),
    DSH_VSCODE_WORKSPACE: workspace,
    DSH_VSCODE_WORKSPACE_WRITE: 'true',
    DSH_VSCODE_EXTENSION_DIR: root,
  },
  shutdownTimeoutMs: 2000,
})

try {
  client.start()
  await client.initialize({ cwd: workspace, provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  const probe = await client.request('debug/spawnProbe', {}, 15000)
  console.log('runtime console:', probe.runtimeConsole, '| probe child:', JSON.stringify(probe.child))
  const ok = probe.runtimeConsole === true && probe.child?.hasConsole === true && probe.child?.visible === false
  console.log(ok
    ? '\nSPAWN PROBE OK — console-subsystem runtime holds a hidden console that children inherit (no flash)'
    : '\nSPAWN PROBE: flash mechanism not resolved')
  process.exit(ok ? 0 : 1)
} catch (error) {
  console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await client.close()
  await rm(buildDir, { recursive: true, force: true })
  await rm(storagePath, { recursive: true, force: true })
}
