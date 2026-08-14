#!/usr/bin/env node
/**
 * Build the VS Code extension with esbuild.
 * - dist/extension.js : the extension host entry (CommonJS, externals kept)
 * - media/*           : copied verbatim into the extension package
 * The @deepseek-ai/* runtime packages stay external: the spawned harness
 * process loads them from this extension's node_modules at runtime.
 */
import { build } from 'esbuild'
import { cpSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))
const watch = process.argv.includes('--watch')

const external = [
  'vscode',
  ...['@deepseek-ai/cordis', '@deepseek-ai/dsh-sdk-client', '@deepseek-ai/dsh-sdk-protocol',
    '@deepseek-ai/dsh-sdk-jsonrpc-server', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-sdk-jsonrpc-demo'].map(p => `${p}/*`),
]

const options = {
  entryPoints: [join(root, 'src/extension.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: join(root, 'dist/extension.js'),
  external,
  sourcemap: false,
  minify: false,
  logLevel: 'info',
}

mkdirSync(join(root, 'dist'), { recursive: true })

if (watch) {
  const ctx = await build({ ...options, watch: true })
  console.log('watching dist/extension.js ...')
} else {
  await build(options)
}
