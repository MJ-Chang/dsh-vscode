/**
 * Preload for the harness runtime child process (Windows only).
 *
 * The runtime is spawned by the extension host as a CONSOLE-subsystem
 * node.exe (see resolveRuntimeNode in src/runtime.ts) so its console is
 * inherited down the sandbox runner → shell chain. The OS creates a console
 * window for that process at spawn; this preload hides it. If the process
 * somehow has no console (console-less launch), AllocConsole is attempted
 * first; if that too is denied, a windowsHide spawn patch minimizes flashes.
 */
'use strict'

if (process.platform === 'win32') {
  let consoleReady = false
  try {
    const koffi = require('koffi')
    const kernel32 = koffi.load('kernel32.dll')
    const user32 = koffi.load('user32.dll')
    const GetConsoleWindow = kernel32.func('void* GetConsoleWindow(void)')
    const AllocConsole = kernel32.func('int AllocConsole(void)')
    const ShowWindow = user32.func('int ShowWindow(void* hWnd, int nCmdShow)')

    let hwnd = GetConsoleWindow()
    if (hwnd === null) {
      // Console-less launch (e.g. CREATE_NO_WINDOW): allocate one.
      if (AllocConsole() !== 0) hwnd = GetConsoleWindow()
    }
    if (hwnd !== null) {
      ShowWindow(hwnd, 0) // SW_HIDE — keep the shared console, hide its window
      consoleReady = true
    }
  } catch (error) {
    process.stderr.write(`[dsh-vscode] hidden-console preload skipped: ${String(error)}\n`)
  }

  if (!consoleReady) {
    const childProcess = require('node:child_process')
    const withWindowsHide = (options) => {
      if (options === undefined) return { windowsHide: true }
      if (typeof options === 'object' && options.windowsHide === undefined) {
        return { ...options, windowsHide: true }
      }
      return options
    }
    const originalSpawn = childProcess.spawn
    childProcess.spawn = function patchedSpawn(command, args, options) {
      return originalSpawn.call(this, command, args, withWindowsHide(options))
    }
    const originalSpawnSync = childProcess.spawnSync
    childProcess.spawnSync = function patchedSpawnSync(command, args, options) {
      return originalSpawnSync.call(this, command, args, withWindowsHide(options))
    }
    const originalExecFileSync = childProcess.execFileSync
    childProcess.execFileSync = function patchedExecFileSync(file, args, options) {
      return originalExecFileSync.call(this, file, args, withWindowsHide(options))
    }
    const originalExecFile = childProcess.execFile
    childProcess.execFile = function patchedExecFile(file, args, options, callback) {
      return originalExecFile.call(this, file, args, withWindowsHide(options), callback)
    }
  }
}
