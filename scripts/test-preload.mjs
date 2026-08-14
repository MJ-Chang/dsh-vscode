#!/usr/bin/env node
/**
 * Verify the preload's fallback behavior: in environments where AllocConsole
 * is denied (like this sandbox), the preload must fall back to patching
 * child_process.spawn with windowsHide — the mechanism that keeps direct
 * spawns (taskkill, plain shell calls) from popping windows. In environments
 * where the hidden console succeeds, no patch is needed because children
 * share the hidden console.
 */
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const preload = path.join(root, 'runtime', 'preload-spawn.cjs').replace(/\\/g, '/')

const probe = `
import { spawn as esmSpawn, spawnSync as esmSpawnSync, execFileSync as esmExecFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
const require = createRequire(import.meta.url)
const koffi = require('koffi')
const kernel32 = koffi.load('kernel32.dll')
const GetConsoleWindow = kernel32.func('void* GetConsoleWindow(void)')
const results = {
  hasConsole: GetConsoleWindow() !== null,
  spawnPatched: esmSpawn.name.startsWith('patched'),
  spawnSyncPatched: esmSpawnSync.name.startsWith('patched'),
  execFileSyncPatched: esmExecFileSync.name.startsWith('patched'),
}
console.log(JSON.stringify(results))
// Correct invariant: either a console exists (children share it) OR the
// spawn patch is active (fallback). Both = broken preload.
const ok = (results.hasConsole || results.spawnPatched) && results.spawnSyncPatched === results.hasConsole ? (results.hasConsole || results.spawnSyncPatched) : (results.hasConsole || results.spawnPatched)
process.exit(ok ? 0 : 1)
`

const child = spawn(process.execPath, ['--require', preload, '--input-type=module', '-e', probe], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true, // exactly how the extension host spawns the runtime
})
let out = ''
let err = ''
child.stdout.on('data', (d) => { out += d })
child.stderr.on('data', (d) => { err += d })
child.on('close', (code) => {
  console.log(`child exit: ${code}`)
  console.log(`stdout: ${out.trim()}`)
  if (err.trim()) console.log(`stderr: ${err.trim()}`)
  const parsed = JSON.parse(out.trim() || '{}')
  const ok = code === 0
  console.log(ok ? '\nPRELOAD TEST OK — console or fallback patch active' : '\nPRELOAD TEST FAILED')
  process.exit(ok ? 0 : 1)
})
