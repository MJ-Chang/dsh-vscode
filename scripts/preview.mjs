#!/usr/bin/env node
/**
 * Generate preview.html: a standalone, browser-openable render of the chat
 * webview with a simulated conversation — so the UI can be reviewed without
 * VS Code. Run: node scripts/preview.mjs → open preview.html
 */
import { readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const html = readFileSync(path.join(root, 'media', 'chat.html'), 'utf8')
const css = readFileSync(path.join(root, 'media', 'chat.css'), 'utf8')
const js = readFileSync(path.join(root, 'media', 'chat.js'), 'utf8')

const lines = [
  'window.acquireVsCodeApi = function () {',
  '  return { postMessage: function (m) { console.log(JSON.stringify(m)) }, getState: function () {}, setState: function () {} }',
  '}',
  'var tick = function (ms) { return new Promise(function (r) { setTimeout(r, ms) }) }',
  'var host = function (data) { window.postMessage(data, "*") }',
  'var run = async function () {',
  '  await tick(300)',
  '  host({ type: "state", configured: true, model: "deepseek-v4-flash", workspace: "my-project", mode: "workspace-write" })',
  '  await tick(200)',
  '  host({ type: "models", models: [',
  '    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", description: "Fast, efficient coding" },',
  '    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", description: "Deep reasoning, best quality" },',
  '  ]})',
  '  await tick(200)',
  '  host({ type: "status", status: "idle" })',
  '  document.getElementById("input").value = "Add a function that parses JSON lines from a file."',
  '  document.getElementById("send-btn").click()',
  '  await tick(300)',
  '  var block = [',
  '    "I will add a parseJsonLines function. First let me look at the project:",',
  '    "",',
  '    "```js",',
  '    "export function parseJsonLines(text) {",',
  '    "  const lines = text.split(/\\\\r?\\\\n/).filter(Boolean)",',
  '    "  return lines.map((line) => JSON.parse(line))",',
  '    "}",',
  '    "```",',
  '    "",',
  '    "Now let me verify it with the test suite.",',
  '  ].join("\\n")',
  '  host({ type: "toolCall", callId: "c1", name: "grep", args: "{\\"pattern\\":\\"parseJsonLines\\",\\"path\\":\\"./src\\"}" })',
  '  await tick(300)',
  '  host({ type: "toolResult", callId: "c1", name: "grep", ok: true, summary: "src/parser.js:3: export function parseJsonLines" })',
  '  var pieces = block.split("\\n")',
  '  for (var i = 0; i < pieces.length; i++) { host({ type: "assistantDelta", text: pieces[i] + "\\n" }); await tick(80) }',
  '  host({ type: "assistantDone" })',
  '  host({ type: "toolCall", callId: "c2", name: "write", args: "{\\"path\\":\\"./src/parser.js\\"}" })',
  '  await tick(300)',
  '  host({ type: "toolResult", callId: "c2", name: "write", ok: true, summary: "Wrote 14 lines to src/parser.js" })',
  '  await tick(200)',
  '  host({ type: "status", status: "idle" })',
  '}',
  'run()',
]
const demo = lines.join('\n')

const preview = html
  .replace('<link rel="stylesheet" href="{{cssUri}}">', `<style>\n${css}\n</style>`)
  .replace('<script nonce="{{nonce}}" src="{{jsUri}}"></script>', `<script>\n${js}\n${demo}\n</script>`)
  .replaceAll('{{cspSource}}', "'unsafe-inline'")
  .replaceAll('{{nonce}}', 'preview')

const out = path.join(root, 'preview.html')
writeFileSync(out, preview, 'utf8')
console.log(`preview written: ${out} (${preview.length} bytes)`)
console.log('open it in a browser to review the UI without VS Code')
