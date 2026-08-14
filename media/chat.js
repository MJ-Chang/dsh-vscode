/**
 * dsh-vscode chat webview: renders the harness event stream and forwards user
 * actions to the extension host over postMessage.
 */
(() => {
  'use strict'

  const vscode = acquireVsCodeApi()

  const messagesEl = document.getElementById('messages')
  const inputEl = document.getElementById('input')
  const sendBtn = document.getElementById('send')
  const stopBtn = document.getElementById('stop')
  const newSessionBtn = document.getElementById('new-session')
  const statusEl = document.getElementById('status')
  const metaEl = document.getElementById('meta')

  let status = 'starting'
  let assistantBlock = null   // the DOM node of the streaming assistant message
  let assistantText = ''
  let busy = false
  const toolCards = new Map() // callId -> { name, card, stateEl, resultEl }

  /** Escape HTML so user/model text can never inject markup. */
  const escapeHtml = (text) =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

  /** Minimal, safe markdown: fenced code, inline code, bold, line breaks. */
  function renderMarkdown(text) {
    const parts = []
    const fence = /```([\w+-]*)\n?([\s\S]*?)```/g
    let last = 0
    let match
    while ((match = fence.exec(text)) !== null) {
      parts.push(renderInline(text.slice(last, match.index)))
      parts.push(`<pre><code>${escapeHtml(match[2].replace(/\n$/, ''))}</code></pre>`)
      last = fence.lastIndex
    }
    parts.push(renderInline(text.slice(last)))
    return parts.join('')
  }

  function renderInline(text) {
    const escaped = escapeHtml(text)
    return escaped
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight
  }

  function addMessageEl(className, html) {
    const el = document.createElement('div')
    el.className = `msg ${className}`
    el.innerHTML = html
    messagesEl.appendChild(el)
    scrollToBottom()
    return el
  }

  // ---------- status ----------

  function setStatus(next) {
    status = next
    statusEl.textContent = next
    statusEl.className = `status status-${next}`
    busy = next === 'busy' || next === 'starting'
    stopBtn.disabled = !busy
    sendBtn.disabled = next === 'starting' || next === 'error'
  }

  function setMeta(text) {
    metaEl.textContent = text
  }

  // ---------- rendering events ----------

  function onSessionId({ sessionId }) {
    setMeta(`session ${sessionId.slice(0, 8)} · runtime ready`)
  }

  function onSystemMessage({ text }) {
    addMessageEl('system', escapeHtml(text))
  }

  function onAssistantDelta({ text }) {
    if (assistantBlock === null) {
      assistantBlock = addMessageEl('assistant streaming', '')
      assistantText = ''
    }
    assistantText += text
    assistantBlock.innerHTML = renderMarkdown(assistantText)
    assistantBlock.classList.add('streaming')
    scrollToBottom()
  }

  function onAssistantDone() {
    if (assistantBlock !== null) {
      assistantBlock.classList.remove('streaming')
    }
    assistantBlock = null
    assistantText = ''
  }

  function onToolCall({ callId, name, args }) {
    let prettyArgs = args
    try { prettyArgs = JSON.stringify(JSON.parse(args), null, 2) } catch { /* keep raw */ }

    const card = document.createElement('details')
    card.className = 'tool-card'
    card.open = true

    const summary = document.createElement('summary')
    const nameEl = document.createElement('span')
    nameEl.className = 'tool-name'
    nameEl.textContent = name
    const stateEl = document.createElement('span')
    stateEl.className = 'tool-state'
    stateEl.textContent = 'running…'
    summary.append(nameEl, stateEl)

    const body = document.createElement('div')
    body.className = 'tool-body'
    const argsEl = document.createElement('div')
    argsEl.className = 'tool-args'
    argsEl.textContent = prettyArgs
    const resultEl = document.createElement('div')
    resultEl.className = 'tool-result'
    resultEl.style.display = 'none'
    body.append(argsEl, resultEl)

    card.append(summary, body)
    messagesEl.appendChild(card)
    scrollToBottom()

    toolCards.set(callId, { name, card, stateEl, resultEl })
  }

  function onToolResult({ callId, name, ok, summary }) {
    const record = toolCards.get(callId)
    if (record !== undefined) {
      record.stateEl.textContent = ok ? 'ok' : 'error'
      record.stateEl.classList.toggle('ok', ok)
      record.stateEl.classList.toggle('err', !ok)
      if (summary !== '') {
        record.resultEl.textContent = summary
        record.resultEl.style.display = 'block'
      }
    } else {
      // Result without a visible call (e.g. panel reopened mid-turn).
      const text = `${ok ? '✓' : '✗'} ${name}${summary !== '' ? ` — ${summary}` : ''}`
      addMessageEl('system', escapeHtml(text))
    }
  }

  function onError({ message }) {
    onAssistantDone()
    addMessageEl('system', escapeHtml(`⚠ ${message}`))
    setStatus('error')
  }

  function onClear() {
    messagesEl.replaceChildren()
    toolCards.clear()
    onAssistantDone()
    setStatus('idle')
  }

  // ---------- host messages ----------

  window.addEventListener('message', (event) => {
    const message = event.data
    switch (message.type) {
      case 'status': setStatus(message.status); if (message.detail) onError({ message: message.detail }); break
      case 'sessionId': onSessionId(message); break
      case 'systemMessage': onSystemMessage(message); break
      case 'assistantDelta': onAssistantDelta(message); break
      case 'assistantDone': onAssistantDone(); break
      case 'toolCall': onToolCall(message); break
      case 'toolResult': onToolResult(message); break
      case 'error': onError(message); break
      case 'clear': onClear(); break
      default: break
    }
  })

  // ---------- user actions ----------

  function send() {
    const text = inputEl.value.trim()
    if (text === '' || busy && status !== 'idle') return
    inputEl.value = ''
    inputEl.style.height = 'auto'
    addMessageEl('user', escapeHtml(text))
    vscode.postMessage({ type: 'prompt', text })
  }

  sendBtn.addEventListener('click', send)
  inputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  })
  stopBtn.addEventListener('click', () => { vscode.postMessage({ type: 'stop' }) })
  newSessionBtn.addEventListener('click', () => { vscode.postMessage({ type: 'newSession' }) })

  setStatus('starting')
  setMeta('connecting to the DeepSeek Harness runtime…')
  vscode.postMessage({ type: 'ready' })
})()
