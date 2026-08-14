/**
 * Preload for the harness runtime child process: inject `windowsHide: true`
 * into every child_process.spawn on Windows.
 *
 * The runtime is spawned by the VS Code extension host (a GUI process with no
 * console), and the harness's subprocess provider does not set windowsHide —
 * so every shell command would otherwise pop a console window. The harness
 * packages are ESM; their `import { spawn } from 'node:child_process'`
 * bindings re-read the CJS exports object, so patching it here (before the
 * app loads, via --require) covers every later spawn in the process.
 */
'use strict'

if (process.platform === 'win32') {
  const childProcess = require('node:child_process')
  const originalSpawn = childProcess.spawn
  childProcess.spawn = function patchedSpawn(command, args, options) {
    if (options === undefined) {
      options = { windowsHide: true }
    } else if (typeof options === 'object' && options.windowsHide === undefined) {
      options = { ...options, windowsHide: true }
    }
    return originalSpawn.call(this, command, args, options)
  }
}
