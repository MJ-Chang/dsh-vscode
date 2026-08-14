#!/usr/bin/env node
/**
 * Plugin-install end-to-end test: builds a tiny harness plugin package,
 * installs it through src/plugins.ts (npm into a storage dir), generates the
 * effective runtime config (base include + user include), boots the runtime,
 * and verifies the plugin actually loaded (it writes a marker file on apply).
 */
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)

// --- 1. compile src/plugins.ts standalone so the test exercises the real code ---
// Not bundled: the CJS yaml package cannot be converted to ESM by esbuild;
// the real extension bundle (CJS output) bundles it fine.
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

// --- 2. create a tiny harness plugin package (bundle-style) ---
const pkgDir = path.join(root, '.test-plugin')
const marker = path.join(root, '.test-plugin-marker.txt')
await rm(pkgDir, { recursive: true, force: true })
await rm(marker, { force: true })
await rm(path.join(root, '.test-storage'), { recursive: true, force: true })
await mkdir(pkgDir, { recursive: true })
await writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({
  name: 'dsh-test-hello',
  version: '0.0.1',
  type: 'module',
  main: 'index.mjs',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}, null, 2), 'utf8')
await writeFile(path.join(pkgDir, 'index.mjs'), `
import { writeFileSync } from 'node:fs'
export const name = 'dsh-test-hello'
export function apply() {
  writeFileSync(process.env.DSH_TEST_PLUGIN_MARKER, 'loaded', 'utf8')
}
`, 'utf8')
await writeFile(path.join(pkgDir, 'cordis.patch.yml'), `
- insert:
    - id: test-hello
      name: 'dsh-test-hello'
`, 'utf8')

const paths = { extensionPath: root, storagePath: path.join(root, '.test-storage') }
let failed = false
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed = true
}

try {
  // --- 3. install the local package through the real plugin manager ---
  await plugins.installPlugin(pkgDir, paths)
  const installed = await plugins.listPlugins(paths)
  check('plugin installed', installed.includes('dsh-test-hello'), `installed: ${installed.join(', ')}`)
  const userConfig = await readFile(path.join(paths.storagePath, 'runtime-plugins', 'user.cordis.yml'), 'utf8')
  check('user layer references the package', userConfig.includes('dsh-test-hello'))

  // --- 4. generate the effective config and boot the runtime ---
  const configPath = await plugins.generateEffectiveConfig(paths)
  check('effective config generated', configPath.includes('effective.cordis.yml'))
  const effective = await readFile(configPath, 'utf8')
  check('effective config includes base', effective.includes('cordis.yml'))
  check('effective config includes user layer', effective.includes('user.cordis.yml'))

  const bin = require.resolve('@deepseek-ai/dsh-sdk-jsonrpc-demo/bin')
  const workspace = path.join(root, '.smoke-workspace')
  await mkdir(workspace, { recursive: true })
  const client = new HarnessClient({
    command: process.execPath,
    args: [bin, configPath],
    cwd: workspace,
    env: {
      ...process.env,
      DSH_SESSION_ROOT: path.join(paths.storagePath, 'sessions'),
      DSH_VSCODE_WORKSPACE: workspace,
      DSH_VSCODE_WORKSPACE_WRITE: 'true',
      DSH_TEST_PLUGIN_MARKER: marker,
    },
    shutdownTimeoutMs: 2000,
  })
  try {
    client.start()
    const init = await client.initialize({ cwd: workspace, provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    check('runtime boots with user plugin layer', init.serverInfo.name === 'deepseek-harness-sdk-runtime')
    let markerContent = ''
    try { markerContent = await readFile(marker, 'utf8') } catch { /* absent */ }
    check('user plugin apply() ran', markerContent === 'loaded', `marker: ${JSON.stringify(markerContent)}`)
  } finally {
    await client.close()
  }

  // --- 5. remove the plugin and verify the layer empties ---
  await plugins.removePlugin('dsh-test-hello', paths)
  const after = await plugins.listPlugins(paths)
  check('plugin removed', after.length === 0, `remaining: ${after.join(', ')}`)
} catch (error) {
  console.error(`[FAIL] ${error instanceof Error ? error.stack : String(error)}`)
  failed = true
} finally {
  await rm(pkgDir, { recursive: true, force: true })
  await rm(marker, { force: true })
  await rm(path.join(root, '.test-storage'), { recursive: true, force: true })
  await rm(buildDir, { recursive: true, force: true })
}

console.log(failed ? '\nPLUGIN TEST FAILED' : '\nPLUGIN TEST OK')
process.exit(failed ? 1 : 0)
