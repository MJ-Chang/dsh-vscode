/**
 * Plugin manager for the embedded harness runtime: installs third-party
 * harness plugin packages (npm / git / local path) into the extension's
 * global storage, and generates the user plugin layer (user.cordis.yml) the
 * runtime boots on top of the built-in composition — "everything is a
 * plugin" applies to the embedded runtime too.
 *
 * vscode-free: takes extension/storage paths so the runtime module can reuse
 * the effective-config generation.
 */

import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

const execFileAsync = promisify(execFile)

/** Paths the plugin manager needs. */
export interface PluginPaths {
  /** Extension install root (built-in runtime/cordis.yml lives here). */
  extensionPath: string
  /** VS Code global storage root (plugins + effective config live here). */
  storagePath: string
}

function pluginsDir(paths: PluginPaths): string {
  return path.join(paths.storagePath, 'runtime-plugins')
}

function userConfigPath(paths: PluginPaths): string {
  return path.join(pluginsDir(paths), 'user.cordis.yml')
}

function effectiveConfigPath(paths: PluginPaths): string {
  return path.join(paths.storagePath, 'runtime', 'effective.cordis.yml')
}

/** npm executable for this platform. */
function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

/**
 * Spawn npm as `node <npm-cli.js>` so it works without a shell (cmd.exe is
 * not spawnable in every environment, including some sandboxes); falls back
 * to the platform npm executable.
 * @returns a spawn-ready [command, args] pair.
 */
function npmSpawn(args: string[]): [string, string[]] {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  for (const candidate of candidates) {
    // Only JS entry points can be run through node; npm_execpath can point at
    // a native executable (e.g. pnpm's exe) which node cannot load.
    if (candidate !== undefined && candidate !== '' && /\.(js|mjs|cjs)$/i.test(candidate)) {
      return [process.execPath, [candidate, ...args]]
    }
  }
  return [npmCommand(), args]
}

/** Run npm in the plugins directory. */
async function runNpm(args: string[], paths: PluginPaths): Promise<string> {
  const dir = pluginsDir(paths)
  await mkdir(dir, { recursive: true })
  // Own package.json so npm treats the plugins dir as its project root
  // instead of walking up into the extension's own node_modules.
  const ownManifest = path.join(dir, 'package.json')
  try {
    await readFile(ownManifest, 'utf8')
  } catch {
    await writeFile(ownManifest, JSON.stringify({
      name: 'dsh-vscode-runtime-plugins',
      version: '0.0.0',
      private: true,
    }, null, 2), 'utf8')
  }
  try {
    const [command, spawnArgs] = npmSpawn(args)
    const { stdout } = await execFileAsync(command, spawnArgs, {
      cwd: dir,
      windowsHide: true,
      timeout: 180_000,
    })
    return stdout
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `npm ${args.join(' ')} failed. Is Node.js/npm installed and on PATH?\n${detail}`,
    )
  }
}

/** Installed plugin package names under the plugins directory. */
async function installedPackages(paths: PluginPaths): Promise<string[]> {
  const dir = path.join(pluginsDir(paths), 'node_modules')
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    // Local-path installs arrive as symlinks; Dirent.isDirectory() is false
    // for symlinks, so accept both.
    return entries
      .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/** A row the user plugin layer should contain for one installed package. */
interface PluginRow {
  id: string
  name: string
  config?: Record<string, unknown>
}

/**
 * Resolve a row's plugin name to an absolute file URL. Bare names do NOT
 * resolve from a nested include's directory in the current loader, so every
 * row points straight at the installed package's entry file.
 */
async function resolveEntryUrl(rawName: string, paths: PluginPaths): Promise<string> {
  if (rawName.startsWith('.') || rawName.startsWith('/') || rawName.startsWith('file:')) {
    return rawName.startsWith('file:') ? rawName : pathToFileURL(rawName).href
  }
  const segments = rawName.split('/')
  const pkg = segments[0]
  const pkgDir = path.join(pluginsDir(paths), 'node_modules', pkg)
  const rest = segments.slice(1)
  if (rest.length === 0) {
    let manifest: { main?: string } = {}
    try {
      manifest = JSON.parse(await readFile(path.join(pkgDir, 'package.json'), 'utf8')) as typeof manifest
    } catch {
      return pathToFileURL(path.join(pkgDir, 'index.js')).href
    }
    const main = manifest.main ?? 'index.js'
    return pathToFileURL(path.join(pkgDir, main)).href
  }
  const sub = path.join(pkgDir, ...rest)
  const candidates = [sub, `${sub}.mjs`, `${sub}.js`, `${sub}.ts`]
  for (const candidate of candidates) {
    try {
      await readFile(candidate)
      return pathToFileURL(candidate).href
    } catch { /* try next */ }
  }
  return pathToFileURL(sub).href
}

/** Read a package's dsh.bundle patch file (if any) and extract its insert rows. */
async function rowsForPackage(pkg: string, paths: PluginPaths): Promise<PluginRow[]> {
  const dir = path.join(pluginsDir(paths), 'node_modules', pkg)
  let manifest: { dsh?: { bundle?: { patch?: string } } } = {}
  try {
    manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as typeof manifest
  } catch {
    return []
  }
  const patch = manifest.dsh?.bundle?.patch
  if (patch === undefined || patch === '') return []

  let patchData: unknown
  try {
    patchData = parseYaml(await readFile(path.join(dir, patch), 'utf8'))
  } catch {
    return []
  }
  const rows: PluginRow[] = []
  if (Array.isArray(patchData)) {
    for (const operation of patchData) {
      const inserted = (operation as { insert?: unknown[] })?.insert
      if (!Array.isArray(inserted)) continue
      for (const row of inserted) {
        const record = row as { id?: unknown; name?: unknown; config?: Record<string, unknown> }
        if (typeof record.name !== 'string') continue
        rows.push({
          id: typeof record.id === 'string' ? record.id : `${pkg}-${rows.length}`,
          name: await resolveEntryUrl(record.name, paths),
          ...(record.config === undefined ? {} : { config: record.config }),
        })
      }
    }
  }
  return rows
}

/** Regenerate user.cordis.yml from what is currently installed. */
async function writeUserConfig(paths: PluginPaths): Promise<void> {
  const dir = pluginsDir(paths)
  await mkdir(dir, { recursive: true })
  const packages = await installedPackages(paths)
  const rows: PluginRow[] = []
  for (const pkg of packages) {
    const bundleRows = await rowsForPackage(pkg, paths)
    if (bundleRows.length > 0) {
      rows.push(...bundleRows)
    } else {
      rows.push({ id: pkg.replace(/[^a-zA-Z0-9_-]/g, '-'), name: await resolveEntryUrl(pkg, paths) })
    }
  }
  // The plugin layer is an entry list (the format Include files read), with
  // each row referencing its package by name so Node resolution finds it.
  const content = rows.length === 0
    ? ''
    : stringifyYaml(rows.map(({ id, name, config }) => ({
      id,
      name,
      ...(config === undefined ? {} : { config }),
    })))
  await writeFile(userConfigPath(paths), content, 'utf8')
}

/** Install a plugin package (npm spec: name, git URL, or local path). */
export async function installPlugin(spec: string, paths: PluginPaths): Promise<void> {
  await runNpm(['install', '--no-save', spec], paths)
  await writeUserConfig(paths)
}

/** Remove an installed plugin package and regenerate the layer. */
export async function removePlugin(pkg: string, paths: PluginPaths): Promise<void> {
  await runNpm(['uninstall', pkg], paths)
  await writeUserConfig(paths)
}

/** List installed plugin packages. */
export async function listPlugins(paths: PluginPaths): Promise<string[]> {
  return installedPackages(paths)
}

/** Whether the user plugin layer currently has any rows. */
async function hasUserPlugins(paths: PluginPaths): Promise<boolean> {
  try {
    const content = await readFile(userConfigPath(paths), 'utf8')
    return content.trim() !== ''
  } catch {
    return false
  }
}

/**
 * Generate the effective runtime config (base include + user include) and
 * return its path. Boot the runtime with this file; the built-in composition
 * still resolves from the extension, user plugins from the plugins dir.
 */
export async function generateEffectiveConfig(paths: PluginPaths): Promise<string> {
  const basePath = path.join(paths.extensionPath, 'runtime', 'cordis.yml')
  const rows: unknown[] = [{
    id: 'dsh-base',
    name: 'cordis:include',
    config: { path: pathToFileURL(basePath).href },
  }]
  if (await hasUserPlugins(paths)) {
    rows.push({
      id: 'dsh-user-plugins',
      name: 'cordis:include',
      config: { path: pathToFileURL(userConfigPath(paths)).href },
    })
  }
  const target = effectiveConfigPath(paths)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, stringifyYaml(rows), 'utf8')
  return target
}

/** Remove the whole plugins directory. */
export async function clearPlugins(paths: PluginPaths): Promise<void> {
  await rm(pluginsDir(paths), { recursive: true, force: true })
}
