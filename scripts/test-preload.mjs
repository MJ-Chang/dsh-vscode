#!/usr/bin/env node
/**
 * Verify the no-flash preload in BOTH runtime modes:
 *
 * 1. REAL MODE — Code.exe with ELECTRON_RUN_AS_NODE (how the extension host
 *    spawns the runtime): AllocConsole must succeed, giving the runtime a
 *    hidden console that sandboxed children share → no per-command windows.
 * 2. FALLBACK MODE — plain node (where AllocConsole is denied): the spawn
 *    patch must be active instead.
 */
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const preload = path.join(root, 'runtime', 'preload-spawn.cjs').replace(/\\/g, '/')
const codeExe = 'C:\\Users\\iamyt\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'
const koffiPath = path.join(root, 'node_modules', 'koffi').replace(/\\/g, '/')

let failed = false
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed = true
}

function runProbe(command, args, env, probeSource) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env, windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('close', (code) => resolve({ code, out, err }))
  })
}

// 1. REAL MODE: Code.exe + ELECTRON_RUN_AS_NODE (needs the preload itself,
//    which calls koffi — so probe inside a --require'd script).
const realProbe = `
const koffi = require(${JSON.stringify(koffiPath)})
const kernel32 = koffi.load('kernel32.dll')
const user32 = koffi.load('user32.dll')
const GetConsoleWindow = kernel32.func('void* GetConsoleWindow(void)')
const AllocConsole = kernel32.func('int AllocConsole(void)')
const ShowWindow = user32.func('int ShowWindow(void* hWnd, int nCmdShow)')
const before = GetConsoleWindow()
const alloc = AllocConsole()
const after = GetConsoleWindow()
let hidden = 0
if (after !== null) hidden = ShowWindow(after, 0)
console.log('RESULT=' + JSON.stringify({ before: before !== null, alloc, after: after !== null, hidden }))
`
const realResult = await runProbe(
  codeExe,
  ['--require', preload, '-e', realProbe],
  { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  realProbe,
)
console.log(`[real mode] exit=${realResult.code} ${realResult.out.trim()}${realResult.err.trim() ? ` stderr=${realResult.err.trim()}` : ''}`)
const real = JSON.parse((realResult.out.match(/RESULT=(\{.*\})/) ?? [])[1] ?? '{}')
// The probe runs AFTER the preload: a console present means the preload
// allocated (and hid) it — exactly what sandboxed children need to share.
check('real mode: runtime ends up with a (hidden) console', real.after === true)

// 2. FALLBACK MODE: plain node — spawn patch must be active.
const fallbackProbe = `
import { spawn as esmSpawn, spawnSync as esmSpawnSync, execFileSync as esmExecFileSync } from 'node:child_process'
console.log('RESULT=' + JSON.stringify({
  spawnPatched: esmSpawn.name.startsWith('patched'),
  spawnSyncPatched: esmSpawnSync.name.startsWith('patched'),
  execFileSyncPatched: esmExecFileSync.name.startsWith('patched'),
}))
`
const fallbackResult = await runProbe(
  process.execPath,
  ['--require', preload, '--input-type=module', '-e', fallbackProbe],
  process.env,
  fallbackProbe,
)
console.log(`[fallback mode] exit=${fallbackResult.code} ${fallbackResult.out.trim()}`)
const fallback = JSON.parse((fallbackResult.out.match(/RESULT=(\{.*\})/) ?? [])[1] ?? '{}')
check('fallback mode: spawn patch active when console is denied', fallback.spawnPatched === true && fallback.spawnSyncPatched === true)

console.log(failed ? '\nPRELOAD TEST FAILED' : '\nPRELOAD TEST OK — no-flash mechanism verified in both runtime modes')
process.exit(failed ? 1 : 0)
