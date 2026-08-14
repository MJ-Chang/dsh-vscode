/**
 * dsh-vscode chat webview — layout and interactions modeled on Claude Code's
 * VS Code extension: setup screen, message containers, model & permission
 * mode menus, history, streaming assistant text, tool cards.
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
  const sendBtn = document.getElementById('send-btn')
  const statusEl = document.getElementById('status')
  const workspaceEl = document.getElementById('workspace')
  const modelBtn = document.getElementById('model-btn')
  const modelName = document.getElementById('model-name')
  const modeBtn = document.getElementById('mode-btn')
  const modeName = document.getElementById('mode-name')
  const historyBtn = document.getElementById('history-btn')
  const menuLayer = document.getElementById('menu-layer')
  const modelMenu = document.getElementById('model-menu')
  const modeMenu = document.getElementById('mode-menu')

  const MODE_LABELS = {
    'read-only': 'Read-only',
    'workspace-write': 'Workspace',
    'danger-full-access': 'Full access',
  }

  let status = 'starting'
  let busy = false
  let assistantContainer = null
  let assistantBlock = null
  let assistantText = ''
  let currentModel = ''
  let currentMode = 'workspace-write'
  let modelCatalog = []
  const toolCards = new Map()

  // ---------- utils ----------

  const escapeHtml = (text) =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

  function renderMarkdown(text) {
    const parts = []
    const fence = /```([\w+-]*)\n?([\s\S]*?)```/g
    let last = 0
    let match
    while ((match = fence.exec(text)) !== null) {
      parts.push(renderBlock(text.slice(last, match.index)))
      const lang = match[1]
      const code = escapeHtml(match[2].replace(/\n$/, ''))
      parts.push(lang ? `<pre><code data-lang="${escapeHtml(lang)}">${code}</code></pre>`
                      : `<pre><code>${code}</code></pre>`)
      last = fence.lastIndex
    }
    parts.push(renderBlock(text.slice(last)))
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
        out.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`)
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

  function addContainer(label) {
    const container = document.createElement('div')
    container.className = 'message-container'
    if (label) {
      const labelEl = document.createElement('div')
      labelEl.className = 'msg-label'
      labelEl.textContent = label
      container.appendChild(labelEl)
    }
    messagesEl.appendChild(container)
    scrollToBottom()
    return container
  }

  function addMessageEl(className, html, container) {
    const el = document.createElement('div')
    el.className = `msg ${className}`
    el.innerHTML = html
    ;(container ?? messagesEl).appendChild(el)
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
    sendBtn.disabled = next === 'starting' || next === 'error'
    sendBtn.textContent = busy ? 'Stop' : 'Send'
    sendBtn.classList.toggle('stop', busy)
    inputEl.disabled = next === 'starting'
  }

  // ---------- menus ----------

  function closeMenus() {
    modelMenu.hidden = true
    modeMenu.hidden = true
    menuLayer.hidden = true
  }

  function renderMenu(menuEl, items, selectedValue, onPick) {
    menuEl.replaceChildren()
    for (const item of items) {
      const row = document.createElement('div')
      row.className = `menu-item${item.value === selectedValue ? ' selected' : ''}`
      const label = document.createElement('div')
      label.className = 'menu-item-label'
      label.innerHTML = `${escapeHtml(item.label)}${item.value === selectedValue ? '<span class="check">✓</span>' : ''}`
      row.appendChild(label)
      if (item.description) {
        const desc = document.createElement('div')
        desc.className = 'menu-item-desc'
        desc.textContent = item.description
        row.appendChild(desc)
      }
      row.addEventListener('click', () => {
        closeMenus()
        onPick(item.value)
      })
      menuEl.appendChild(row)
    }
  }

  function openMenu(menuEl) {
    closeMenus()
    menuEl.hidden = false
    menuLayer.hidden = false
  }

  modelBtn.addEventListener('click', () => {
    renderMenu(modelMenu, modelCatalog.length > 0 ? modelCatalog.map((m) => ({
      value: m.id,
      label: m.name ?? m.id,
      description: m.description ?? '',
    })) : [{ value: currentModel, label: currentModel, description: '' }], currentModel, (model) => {
      if (model !== currentModel) {
        currentModel = model
        modelName.textContent = model
        addMessageEl('system', `New conversation · model: ${model}`)
        vscode.postMessage({ type: 'setModel', text: model })
      }
    })
    openMenu(modelMenu)
  })

  modeBtn.addEventListener('click', () => {
    renderMenu(modeMenu, Object.entries(MODE_LABELS).map(([value, label]) => ({
      value,
      label,
      description: value === 'read-only' ? 'The agent can only read files.'
        : value === 'workspace-write' ? 'Can edit files inside the workspace.'
          : 'Full filesystem access (use with care).',
    })), currentMode, (mode) => {
      if (mode !== currentMode) {
        currentMode = mode
        modeName.textContent = MODE_LABELS[mode]
        vscode.postMessage({ type: 'setMode', text: mode })
      }
    })
    openMenu(modeMenu)
  })

  historyBtn.addEventListener('click', () => {
    closeMenus()
    vscode.postMessage({ type: 'listSessions' })
  })

  document.addEventListener('click', (event) => {
    if (!event.target.closest('.menu')) closeMenus()
  })

  // ---------- host events ----------

  function onState({ configured, model, workspace, mode }) {
    currentModel = model
    currentMode = mode ?? 'workspace-write'
    modelName.textContent = model
    modeName.textContent = MODE_LABELS[currentMode]
    workspaceEl.textContent = workspace || 'no workspace'
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
    vscode.postMessage({ type: 'listSessions' })
  }

  function onModels({ models }) {
    modelCatalog = Array.isArray(models) ? models : []
    if (modelCatalog.length > 0 && modelCatalog.some((m) => m.id === currentModel)) {
      // keep current selection
    } else if (modelCatalog.length > 0) {
      currentModel = modelCatalog[0].id
      modelName.textContent = currentModel
    }
  }

  function onSessions({ sessions }) {
    const list = Array.isArray(sessions) ? sessions : []
    if (list.length === 0) {
      addMessageEl('system', 'No previous conversations yet.')
      return
    }
    const container = addContainer('HISTORY')
    for (const session of list) {
      const row = document.createElement('div')
      row.className = 'menu-item'
      const label = document.createElement('div')
      label.className = 'menu-item-label'
      label.textContent = `${session.createdAt ? new Date(session.createdAt).toLocaleString() : 'unknown'} · ${session.sessionId.slice(0, 10)}`
      row.appendChild(label)
      row.addEventListener('click', () => {
        container.remove()
        addMessageEl('system', 'Resuming previous conversation…')
        vscode.postMessage({ type: 'resumeSession', text: session.sessionId })
      })
      container.appendChild(row)
    }
  }

  function onSystemMessage({ text }) {
    addMessageEl('system', escapeHtml(text))
  }

  function onAssistantDelta({ text }) {
    if (assistantBlock === null) {
      assistantContainer = addContainer('ASSISTANT')
      assistantBlock = addMessageEl('assistant streaming', '', assistantContainer)
      assistantText = ''
    }
    assistantText += text
    assistantBlock.innerHTML = renderMarkdown(assistantText)
    assistantBlock.classList.add('streaming')
    scrollToBottom()
  }

  function onAssistantDone() {
    if (assistantBlock !== null) assistantBlock.classList.remove('streaming')
    assistantBlock = null
    assistantContainer = null
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

  window.addEventListener('message', (event) => {
    const message = event.data
    switch (message.type) {
      case 'state': onState(message); break
      case 'configured': onConfigured(); break
      case 'models': onModels(message); break
      case 'sessions': onSessions(message); break
      case 'status': setStatus(message.status); break
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
    if (busy) {
      vscode.postMessage({ type: 'stop' })
      return
    }
    const text = inputEl.value.trim()
    if (text === '') return
    inputEl.value = ''
    inputEl.style.height = 'auto'
    const container = addContainer('YOU')
    addMessageEl('user', escapeHtml(text), container)
    vscode.postMessage({ type: 'prompt', text })
  }

  sendBtn.addEventListener('click', send)
  inputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  })

  vscode.postMessage({ type: 'ready' })
})()
