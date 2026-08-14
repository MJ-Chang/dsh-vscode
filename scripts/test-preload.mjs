#!/usr/bin/env node
/**
 * Verify the windowsHide preload reaches the harness's spawn path: spawn a
 * node child with `--require runtime/preload-spawn.cjs`, then from THAT child
 * check that both the CJS export and the ESM named import of
 * child_process.spawn resolve to the patched function (the harness packages
 * import it via ESM named imports, which re-read the CJS exports object).
 */
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const preload = path.join(root, 'runtime', 'preload-spawn.cjs').replace(/\\/g, '/')

const probe = `
import { spawn as esmSpawn } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const cjsSpawn = require('node:child_process').spawn
const results = {
  cjsPatched: cjsSpawn.name === 'patchedSpawn',
  esmPatched: esmSpawn.name === 'patchedSpawn',
}
console.log(JSON.stringify(results))
process.exit(results.cjsPatched && results.esmPatched ? 0 : 1)
`

const child = spawn(process.execPath, ['--require', preload, '--input-type=module', '-e', probe], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
let err = ''
child.stdout.on('data', (d) => { out += d })
child.stderr.on('data', (d) => { err += d })
child.on('close', (code) => {
  console.log(`child exit: ${code}`)
  console.log(`stdout: ${out.trim()}`)
  if (err.trim()) console.log(`stderr: ${err.trim()}`)
  const ok = code === 0 && out.includes('"cjsPatched":true') && out.includes('"esmPatched":true')
  console.log(ok ? '\nPRELOAD TEST OK — spawn is patched for ESM and CJS consumers' : '\nPRELOAD TEST FAILED')
  process.exit(ok ? 0 : 1)
})
