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
