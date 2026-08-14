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

// --- no-workspace state → actionable message, key input hidden ---
await post({ type: 'state', configured: false, noWorkspace: true, model: 'deepseek-v4-flash', workspace: '', workspacePath: '', mode: 'workspace-write' })
check('no-workspace shows setup with message', !document.getElementById('setup').hidden)
check('no-workspace hides the key input', document.getElementById('setup-key-group').hidden)
check('no-workspace message shown', document.getElementById('setup-error').textContent.includes('workspace folder'))

// --- unconfigured state → setup screen ---
await post({ type: 'state', configured: false, model: 'deepseek-v4-flash', workspace: 'demo', workspacePath: 'C:/demo', mode: 'workspace-write' })
check('setup screen visible when not configured', !document.getElementById('setup').hidden)
check('key input visible again with a workspace', !document.getElementById('setup-key-group').hidden)

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

// --- presets ---
await post({
  type: 'presets',
  presets: [
    { id: 'default', name: 'Default', description: 'Full coding agent' },
    { id: 'minimal', name: 'Minimal', description: 'Files only' },
  ],
})
check('preset pill shows a preset', document.getElementById('preset-name').textContent === 'default')
document.getElementById('preset-btn').click()
await tick()
check('preset menu stays open after clicking its button', !document.getElementById('preset-menu').hidden)
const minimalItem = [...document.querySelectorAll('#preset-menu .menu-item')].find((el) => el.textContent.includes('Minimal'))
minimalItem?.click()
await tick()
check('selecting a preset posts setPreset', posted.some((m) => m.type === 'setPreset' && m.text === 'minimal'))
check('preset pill updates', document.getElementById('preset-name').textContent === 'minimal')

// --- settings menu ---
document.getElementById('settings-btn').click()
await tick()
check('settings menu opens', !document.getElementById('settings-menu').hidden)
check('settings menu has key + plugin entries', [...document.querySelectorAll('#settings-menu .menu-item-label')].some((el) => el.textContent.includes('Install Plugin')))

// --- new conversation button ---
document.getElementById('new-session-btn').click()
await tick()
check('new-session button posts newSession', posted.some((m) => m.type === 'newSession'))

// --- model menu opens and stays open (regression: instant-close bug) ---
document.getElementById('model-btn').click()
await tick()
check('model menu stays open after clicking its button', !document.getElementById('model-menu').hidden)
const proItem = [...document.querySelectorAll('#model-menu .menu-item')].find((el) => el.textContent.includes('DeepSeek V4 Pro'))
proItem?.click()
await tick()
check('selecting a model posts setModel', posted.some((m) => m.type === 'setModel' && m.text === 'deepseek-v4-pro'))
check('model pill updates', document.getElementById('model-name').textContent === 'deepseek-v4-pro')

// --- mode menu opens and switching posts setMode ---
document.getElementById('mode-btn').click()
await tick()
check('mode menu stays open after clicking its button', !document.getElementById('mode-menu').hidden)
const readOnlyItem = [...document.querySelectorAll('#mode-menu .menu-item')].find((el) => el.textContent.includes('Read-only'))
readOnlyItem?.click()
await tick()
check('selecting a mode posts setMode', posted.some((m) => m.type === 'setMode' && m.text === 'read-only'))
check('mode pill not updated until host confirms', document.getElementById('mode-name').textContent === 'Workspace')
await post({ type: 'mode', mode: 'read-only' })
check('mode pill updates on host confirmation', document.getElementById('mode-name').textContent === 'Read-only')

// --- workspace copies its path ---
document.getElementById('workspace').click()
await tick()
check('workspace click posts copyPath', posted.some((m) => m.type === 'copyPath'))

// --- multi-root workspace switcher ---
await post({
  type: 'workspaces',
  folders: [{ name: 'alpha', path: 'C:/alpha' }, { name: 'beta', path: 'C:/beta' }],
  active: 'C:/alpha',
})
document.getElementById('workspace').click()
await tick()
check('multi-root click opens workspace menu', !document.getElementById('workspace-menu').hidden)
check('workspace menu lists both folders', document.querySelectorAll('#workspace-menu .menu-item').length === 2)
const betaItem = [...document.querySelectorAll('#workspace-menu .menu-item')].find((el) => el.textContent.includes('beta'))
betaItem?.click()
await tick()
check('picking a folder posts setWorkspace', posted.some((m) => m.type === 'setWorkspace' && m.text === 'C:/beta'))

// --- sessions (history menu) ---
await post({ type: 'sessions', sessions: [{ sessionId: 'abc123', createdAt: Date.now() }] })
check('history menu opened', !document.getElementById('history-menu').hidden)
check('history menu has items incl. new conversation', document.querySelectorAll('#history-menu .menu-item').length >= 2)
check('history menu offers New conversation', [...document.querySelectorAll('#history-menu .menu-item')].some((el) => el.textContent.includes('New conversation')))
await post({ type: 'sessions', sessions: [{ sessionId: 'titled-1', createdAt: Date.now(), title: 'Fix the parser' }] })
check('history shows session title when available', [...document.querySelectorAll('#history-menu .menu-item')].some((el) => el.textContent.includes('Fix the parser')))

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

// --- streaming assistant (frame-throttled; flushes on assistantDone) ---
await post({ type: 'assistantDelta', text: 'Hello, ' })
await post({ type: 'assistantDelta', text: 'world!' })
await post({ type: 'assistantDone' })
const assistants = [...document.querySelectorAll('.msg.assistant')]
check('assistant message rendered', assistants.some((el) => el.textContent.includes('world')))

// --- tool call + result ---
await post({ type: 'toolCall', callId: 'call-1', name: 'bash', args: '{"command":"ls"}' })
const toolCard = document.querySelector('.tool-card')
check('tool card rendered', toolCard !== null)
check('tool name shown', toolCard !== null && toolCard.textContent.includes('bash'))
check('tool card collapsed by default', toolCard !== null && toolCard.open === false)
await post({ type: 'toolResult', callId: 'call-1', name: 'bash', ok: true, summary: 'file1 file2' })
check('tool result marked ok', document.querySelector('.tool-state.ok') !== null)
await post({ type: 'toolCall', callId: 'call-2', name: 'pwsh', args: '{}' })
const errCard = [...document.querySelectorAll('.tool-card')].at(-1)
await post({ type: 'toolResult', callId: 'call-2', name: 'pwsh', ok: false, summary: 'boom' })
check('failed tool card auto-expands', errCard !== undefined && errCard.open === true)

// --- markdown link opens externally ---
const linkEl = document.createElement('a')
linkEl.setAttribute('href', 'https://example.com/docs')
document.getElementById('messages').appendChild(linkEl)
linkEl.click()
await tick()
check('markdown link posts openLink', posted.some((m) => m.type === 'openLink' && m.text === 'https://example.com/docs'))

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
