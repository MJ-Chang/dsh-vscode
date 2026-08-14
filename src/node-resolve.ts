/**
 * Resolve a console-subsystem Node executable on Windows.
 *
 * The extension host's process.execPath is Code.exe (Electron, GUI
 * subsystem): a GUI process's console is never inherited by children, so the
 * sandbox runner → shell chain would create a visible console window per
 * command (the flashing bug). A real node.exe (console subsystem) holds a
 * console the whole chain can share — exactly how the official harness runs.
 */

import { existsSync } from 'node:fs'
import * as path from 'node:path'

/**
 * Resolve the system Node executable (console subsystem) for child processes.
 * @returns an absolute node.exe path, or the host's own executable when none
 * is found (works, but on Windows the runtime may flash console windows).
 */
export function resolveSystemNode(): string {
  if (process.platform !== 'win32') return process.execPath
  const candidates: string[] = [
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
  ]
  for (const dir of (process.env.Path ?? '').split(';')) {
    if (dir !== '') candidates.push(path.join(dir.trim(), 'node.exe'))
  }
  // npm_node_execpath is unreliable under pnpm shims (it can point at pnpm's
  // exe); only accept a real node.exe outside a package-manager store.
  const npmNode = process.env.npm_node_execpath
  if (npmNode !== undefined && /node\.exe$/i.test(npmNode)
    && !/pnpm|\.pnpm|npm-cache|_store/i.test(npmNode)) {
    candidates.unshift(npmNode)
  }
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== '' && existsSync(candidate)
      && !candidate.toLowerCase().includes('microsoft vs code')) {
      return candidate
    }
  }
  return process.execPath
}

/** The npm-cli.js beside a node installation, when present. */
export function npmCliBesideNode(nodePath: string): string | undefined {
  const cli = path.join(path.dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return existsSync(cli) ? cli : undefined
}
