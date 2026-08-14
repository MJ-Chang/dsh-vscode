/**
 * Headless activation test: load dist/extension.js with a stubbed 'vscode'
 * module and call activate() to prove the bundle loads and registers without
 * throwing — isolating extension code issues from VS Code install issues.
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const registeredCommands = []
const registeredViews = []
let activated = false

const fakeVscode = {
  workspace: {
    workspaceFolders: [{ uri: { fsPath: 'C:/fake/workspace' } }],
    getConfiguration: () => ({
      get: (key, def) => {
        if (key === 'model') return 'deepseek-v4-flash'
        if (key === 'apiKeyEnv') return 'DEEPSEEK_API_KEY'
        if (key === 'workspaceWriteOnly') return true
        return def
      },
    }),
  },
  window: {
    registerWebviewViewProvider: (id, provider) => { registeredViews.push(id) },
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showInputBox: async () => undefined,
    withProgress: async (_o, fn) => fn(),
    createWebviewPanel: () => { throw new Error('createWebviewPanel should not be called') },
    ProgressLocation: { Notification: 15 },
  },
  commands: {
    registerCommand: (id, fn) => { registeredCommands.push(id) },
    executeCommand: async () => undefined,
  },
  Uri: { joinPath: (...parts) => ({ fsPath: parts.join('/'), toString: () => parts.join('/') }) },
  ViewColumn: { Beside: 2 },
  EventEmitter: class { event() { return () => ({ dispose() {} }) } },
}

const Module = await import('node:module').then((m) => m.default)
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode
  return originalLoad.call(this, request, parent, isMain)
}

try {
  const ext = require('../dist/extension.js')
  const context = {
    extensionPath: 'C:/fake/ext',
    extensionUri: { fsPath: 'C:/fake/ext' },
    globalStorageUri: { fsPath: 'C:/fake/storage' },
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
    subscriptions: [],
  }
  ext.activate(context)
  activated = true
  console.log('activate() ran without throwing')
  console.log('registered commands:', registeredCommands.join(', '))
  console.log('registered webview views:', registeredViews.join(', '))
  if (registeredViews.includes('dsh-vscode-chat-view')) {
    console.log('SIDEBAR VIEW REGISTERED OK')
  } else {
    console.error('FAIL: chatView was not registered')
    process.exitCode = 1
  }
  ext.deactivate()
  console.log('deactivate() ran without throwing')
} catch (error) {
  console.error('FAIL:', error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
} finally {
  Module._load = originalLoad
}
