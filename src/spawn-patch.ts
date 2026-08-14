/**
 * Host-side Windows spawn patch: inject `windowsHide: true` into every
 * child_process.spawn made by this extension process.
 *
 * The extension host is a GUI process without a console; the SDK client and
 * any other child spawns would otherwise flash console windows. The ESM SDK
 * client's `import { spawn } from 'node:child_process'` re-reads the CJS
 * exports object, so patching here (before any child is spawned) covers it.
 */
export function applyWindowsSpawnPatch(): void {
  if (process.platform !== 'win32') return
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const childProcess = require('node:child_process') as typeof import('node:child_process')
  const original = childProcess.spawn
  if ((original as { __dshPatched?: boolean }).__dshPatched === true) return
  const patched = function (
    this: unknown,
    command: string,
    args?: readonly string[] | undefined,
    options?: object,
  ) {
    // The runtime spawn MUST keep its OS-created console (a console-subsystem
    // node.exe whose console the sandbox chain inherits). windowsHide there
    // would make every shell command flash a new console window.
    const argv = args ?? []
    const isRuntime = argv.some((arg) => typeof arg === 'string'
      && (arg.includes('dsh-sdk-jsonrpc-demo') || arg.includes('preload-spawn.cjs')))
    if (isRuntime) {
      // The runtime spawn keeps its OS-created console (a console-subsystem
      // node.exe whose console the sandbox chain inherits).
      return original.call(this, command, (args ?? []) as readonly string[], options as Parameters<typeof original>[2])
    }
    let opts = options
    if (opts === undefined) {
      opts = { windowsHide: true }
    } else if ((opts as { windowsHide?: boolean }).windowsHide === undefined) {
      opts = { ...opts, windowsHide: true }
    }
    return original.call(this, command, (args ?? []) as readonly string[], opts)
  } as unknown as typeof childProcess.spawn
  ;(patched as { __dshPatched?: boolean }).__dshPatched = true
  childProcess.spawn = patched
}
