/**
 * Preload for the harness runtime child process (Windows only).
 *
 * Goal: shell commands must never flash a console window. Two mechanisms, in
 * order:
 *
 * 1. HIDDEN CONSOLE — allocate a console and hide its window. The windows-acl
 *    sandbox runner spawns its restricted-token child WITHOUT CREATE_NO_WINDOW
 *    (hidden-console children die with STATUS_DLL_INIT_FAILED under that
 *    scheme) and the child "shares the host console". When this process has a
 *    hidden console, every child — pwsh, the runner, taskkill — inherits and
 *    shares it: zero visible windows. An inherited console (runtime launched
 *    from a terminal) is left untouched.
 *
 * 2. FALLBACK PATCH — when no console can be allocated (some environments
 *    deny AllocConsole), inject windowsHide into child_process.spawn /
 *    spawnSync / execFileSync so direct spawns (taskkill, plain shell calls)
 *    do not pop windows either. The sandboxed runner chain may still flash in
 *    this fallback, but the common paths are covered.
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

    if (GetConsoleWindow() === null) {
      if (AllocConsole() !== 0) {
        const hwnd = GetConsoleWindow()
        if (hwnd !== null) ShowWindow(hwnd, 0) // SW_HIDE
        consoleReady = true
      }
    } else {
      consoleReady = true // inherited console: children share it already
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
