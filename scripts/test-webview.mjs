#!/usr/bin/env node
/**
 * Webview render test: loads media/chat.html + chat.js in jsdom with a
 * stubbed acquireVsCodeApi, replays the host message protocol, and asserts
 * the DOM actually renders (setup screen, chat screen, messages, tool cards).
 * Catches the class of bug that leaves the user staring at a broken view.
 */
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const html = readFileSync(path.join(root, 'media', 'chat.html'), 'utf8')
const js = readFileSync(path.join(root, 'media', 'chat.js'), 'utf8')

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true })
const { window } = dom
const { document } = window

const posted = []
window.acquireVsCodeApi = () => ({
  postMessage: (msg) => posted.push(msg),
  getState: () => undefined,
  setState: () => undefined,
})

let failed = false
const check = (name, condition, detail = '') => {
  console.log(`${condition ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failed = true
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))
const post = async (data) => {
  window.postMessage(data, '*')
  await tick()
}

// Inject the webview script.
window.eval(js)
await tick()

check('webview posts ready on load', posted.some((m) => m.type === 'ready'))

// --- unconfigured state → setup screen ---
await post({ type: 'state', configured: false, model: 'deepseek-v4-flash', workspace: 'demo', mode: 'workspace-write' })
check('setup screen visible when not configured', !document.getElementById('setup').hidden)

// --- setupKey flow ---
document.getElementById('key-input').value = 'sk-test'
document.getElementById('connect-btn').click()
await tick()
check('webview posts setupKey', posted.some((m) => m.type === 'setupKey' && m.text === 'sk-test'))

// --- configured state → chat screen ---
await post({ type: 'configured' })
check('chat screen visible after configured', !document.getElementById('chat').hidden)
check('chat screen replaces setup', document.getElementById('setup').hidden)

// --- models ---
await post({
  type: 'models',
  models: [
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  ],
})
check('model pill shows a model', document.getElementById('model-name').textContent !== '')

// --- sessions (history menu) ---
await post({ type: 'sessions', sessions: [{ sessionId: 'abc123', createdAt: Date.now() }] })
check('history menu opened', !document.getElementById('history-menu').hidden)
check('history menu has an item', document.querySelectorAll('#history-menu .menu-item').length > 0)

// --- transcript (resumed conversation) ---
await post({
  type: 'transcript',
  events: [
    { type: 'user/message', data: { content: [{ type: 'text', text: 'earlier question' }], source: { kind: 'user' } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'earlier answer' }] } } },
  ],
})
check('transcript renders user message', [...document.querySelectorAll('.msg.user')].some((el) => el.textContent.includes('earlier question')))
check('transcript renders assistant message', [...document.querySelectorAll('.msg.assistant')].some((el) => el.textContent.includes('earlier answer')))

// --- streaming assistant ---
await post({ type: 'assistantDelta', text: 'Hello, ' })
await post({ type: 'assistantDelta', text: 'world!' })
const assistants = [...document.querySelectorAll('.msg.assistant')]
check('assistant message rendered', assistants.some((el) => el.textContent.includes('world')))

// --- tool call + result ---
await post({ type: 'toolCall', callId: 'call-1', name: 'bash', args: '{"command":"ls"}' })
const toolCard = document.querySelector('.tool-card')
check('tool card rendered', toolCard !== null)
check('tool name shown', toolCard !== null && toolCard.textContent.includes('bash'))
await post({ type: 'toolResult', callId: 'call-1', name: 'bash', ok: true, summary: 'file1 file2' })
check('tool result marked ok', document.querySelector('.tool-state.ok') !== null)

// --- busy/stop state ---
await post({ type: 'status', status: 'busy' })
const sendBtn = document.getElementById('send-btn')
check('send button becomes Stop while busy', sendBtn.textContent === 'Stop')

// --- token usage ---
await post({ type: 'usage', input: 1200, output: 340 })
await post({ type: 'usage', input: 800, output: 100 })
check('usage display accumulates tokens', document.getElementById('usage').textContent.includes('2,000↑') && document.getElementById('usage').textContent.includes('440↓'))

// --- attachments ---
document.getElementById('attach-btn').click()
await tick()
check('attach button posts pickFiles', posted.some((m) => m.type === 'pickFiles'))
await post({ type: 'attachments', files: [{ name: 'src/main.ts', content: 'export const x = 1' }] })
check('attachment chip rendered', document.querySelector('.attachment-chip') !== null)
check('attachment shows file name', document.querySelector('.attachment-chip .name')?.textContent === 'src/main.ts')

// --- user message (after returning to idle) ---
await post({ type: 'status', status: 'idle' })
document.getElementById('input').value = 'fix the bug'
sendBtn.click()
await tick()
check('user message rendered', [...document.querySelectorAll('.msg.user')].some((el) => el.textContent.includes('fix the bug')))
const promptMsg = posted.find((m) => m.type === 'prompt' && m.text === 'fix the bug')
check('prompt posted', promptMsg !== undefined)
check('prompt carries attachments', Array.isArray(promptMsg?.files) && promptMsg.files.length === 1 && promptMsg.files[0].name === 'src/main.ts')
check('attachments cleared after send', document.querySelectorAll('.attachment-chip').length === 0)

// --- error path (composer must NOT strand) ---
await post({ type: 'error', message: 'runtime exploded' })
check('error surfaced as a message', [...document.querySelectorAll('.msg.system')].some((el) => el.textContent.includes('runtime exploded')))
check('send still enabled after error', !document.getElementById('send-btn').disabled)

// --- clear ---
await post({ type: 'clear' })
check('clear empties messages', document.querySelectorAll('.msg').length === 0)
check('welcome hint shown after clear', document.querySelector('.welcome') !== null)

console.log(failed ? '\nWEBVIEW TEST FAILED' : '\nWEBVIEW TEST OK')
process.exit(failed ? 1 : 0)
