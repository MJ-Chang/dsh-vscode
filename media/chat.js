/**
 * dsh-vscode chat webview: setup screen (API key) + chat screen, renders the
 * harness event stream, and forwards user actions to the extension host.
 */
(() => {
  'use strict'

  const vscode = acquireVsCodeApi()

  const setupEl = document.getElementById('setup')
  const chatEl = document.getElementById('chat')
  const keyInput = document.getElementById('key-input')
  const connectBtn = document.getElementById('connect-btn')
  const setupError = document.getElementById('setup-error')

  const messagesEl = document.getElementById('messages')
  const inputEl = document.getElementById('input')
  const sendBtn = document.getElementById('send')
  const stopBtn = document.getElementById('stop')
  const newSessionBtn = document.getElementById('new-session')
  const statusEl = document.getElementById('status')
  const modelEl = document.getElementById('model')
  const workspaceEl = document.getElementById('workspace')

  let status = 'starting'
  let busy = false
  let assistantBlock = null
  let assistantText = ''
  const toolCards = new Map()

  // ---------- utilities ----------

  const escapeHtml = (text) =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

  /** Minimal, safe markdown: fenced code, inline code, bold, italic, links, lists, headings. */
  function renderMarkdown(text) {
    const parts = []
    const fence = /```([\w+-]*)\n?([\s\S]*?)```/g
    let last = 0
    let match
    while ((match = fence.exec(text)) !== null) {
      parts.push(renderInline(text.slice(last, match.index)))
      const lang = match[1]
      const code = escapeHtml(match[2].replace(/\n$/, ''))
      parts.push(lang ? `<pre><code data-lang="${escapeHtml(lang)}">${code}</code></pre>`
                      : `<pre><code>${code}</code></pre>`)
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
      .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
  }

  function renderBlock(text) {
    const lines = text.split('\n')
    const out = []
    let inList = false
    for (const line of lines) {
      const heading = line.match(/^(#{1,4})\s+(.*)$/)
      if (heading) {
        if (inList) { out.push('</ul>'); inList = false }
        const level = heading[1].length
        out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
        continue
      }
      const bullet = line.match(/^\s*[-*]\s+(.*)$/)
      if (bullet) {
        if (!inList) { out.push('<ul>'); inList = true }
        out.push(`<li>${renderInline(bullet[1])}</li>`)
        continue
      }
      if (/^\s*$/.test(line)) {
        if (inList) { out.push('</ul>'); inList = false }
        out.push('<br>')
        continue
      }
      if (inList) { out.push('</ul>'); inList = false }
      out.push(renderInline(line))
    }
    if (inList) out.push('</ul>')
    return out.join('')
  }

  function scrollToBottom() { messagesEl.scrollTop = messagesEl.scrollHeight }

  function addMessageEl(className, html) {
    const el = document.createElement('div')
    el.className = `msg ${className}`
    el.innerHTML = html
    messagesEl.appendChild(el)
    scrollToBottom()
    return el
  }

  // ---------- screens ----------

  function showSetup(message) {
    chatEl.hidden = true
    setupEl.hidden = false
    if (message) {
      setupError.textContent = message
      setupError.hidden = false
    }
    keyInput.focus()
  }

  function showChat() {
    setupEl.hidden = true
    chatEl.hidden = false
    inputEl.focus()
  }

  // ---------- status ----------

  function setStatus(next) {
    status = next
    statusEl.textContent = next
    statusEl.className = `status status-${next}`
    busy = next === 'busy' || next === 'starting'
    stopBtn.disabled = !busy
    sendBtn.disabled = next === 'starting' || next === 'error'
    inputEl.disabled = next === 'starting'
  }

  // ---------- events ----------

  function onState({ configured, model, workspace }) {
    modelEl.textContent = model
    workspaceEl.textContent = workspace
    if (configured) {
      showChat()
      setStatus('starting')
    } else {
      showSetup()
    }
  }

  function onConfigured() {
    showChat()
    setStatus('ready')
  }

  function onSessionId({ sessionId }) {
    workspaceEl.textContent = workspaceEl.textContent || ''
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
    assistantBlock.innerHTML = renderBlock(assistantText)
    assistantBlock.classList.add('streaming')
    scrollToBottom()
  }

  function onAssistantDone() {
    if (assistantBlock !== null) assistantBlock.classList.remove('streaming')
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
      const text = `${ok ? '✓' : '✗'} ${name}${summary !== '' ? ` — ${summary}` : ''}`
      addMessageEl('system', escapeHtml(text))
    }
  }

  function onError({ message }) {
    onAssistantDone()
    if (setupEl.hidden === false) {
      // Key setup failed — stay on the setup screen with the error.
      showSetup(message)
      connectBtn.disabled = false
    } else {
      addMessageEl('system', escapeHtml(`⚠ ${message}`))
      setStatus('error')
    }
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
      case 'state': onState(message); break
      case 'configured': onConfigured(); break
      case 'status': setStatus(message.status); break
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

  async function connect() {
    const key = keyInput.value.trim()
    if (key === '') return
    connectBtn.disabled = true
    setupError.hidden = true
    vscode.postMessage({ type: 'setupKey', text: key })
  }

  connectBtn.addEventListener('click', connect)
  keyInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); void connect() }
  })

  function send() {
    const text = inputEl.value.trim()
    if (text === '' || busy) return
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

  // Ask the host for the current state (configured? model? workspace?).
  vscode.postMessage({ type: 'ready' })
})()
