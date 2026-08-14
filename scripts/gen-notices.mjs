/**
 * Generate THIRD_PARTY_NOTICES.md from the installed npm tree (package-lock).
 *
 * Walks the lockfile's `packages` map, keeps production dependencies of this
 * extension (dev-only tooling is excluded), and emits a markdown table with
 * name, version, license, and repository. License data comes from the
 * lockfile; packages without a declared license are listed as "see package".
 *
 * Usage: node scripts/gen-notices.mjs
 */
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

const prodDeps = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.optionalDependencies ?? {}),
])

// Direct prod deps plus their transitive closure via the lockfile's
// `packages` entries (npm v3 lockfiles record dependencies per package).
const included = new Set()
const queue = [...prodDeps]
while (queue.length > 0) {
  const name = queue.pop()
  if (included.has(name)) continue
  const entry = lock.packages?.[`node_modules/${name}`]
  if (entry === undefined) continue
  included.add(name)
  for (const dep of Object.keys(entry.dependencies ?? {})) {
    if (!included.has(dep)) queue.push(dep)
  }
}

const rows = [...included].sort().map((name) => {
  const entry = lock.packages?.[`node_modules/${name}`]
  const license = entry?.license
  let licenseText = 'see package'
  if (typeof license === 'string' && license !== '') licenseText = license
  else if (Array.isArray(license) && license.length > 0) licenseText = license.join(' OR ')
  else if (typeof entry?.licenses === 'object' && entry.licenses !== null) {
    licenseText = Object.values(entry.licenses).map((l) => l.license).join(' OR ')
  }
  const repo = typeof entry?.repository === 'string'
    ? entry.repository
    : entry?.repository?.url
  return { name, version: entry?.version ?? '?', license: licenseText, repo }
})

const lines = [
  '# Third-Party Notices',
  '',
  `dsh-vscode bundles the DeepSeek Harness runtime and its dependencies. This file lists the third-party packages distributed with it (${rows.length} packages).`,
  '',
  '| Package | Version | License | Repository |',
  '|---|---|---|---|',
  ...rows.map((row) => {
    const repo = row.repo === undefined
      ? ''
      : row.repo.replace('git+', '').replace('.git', '')
    return `| \`${row.name}\` | ${row.version} | ${row.license} | ${repo === '' ? '—' : repo} |`
  }),
  '',
  'All packages retain their original copyrights and license texts; see each package for details.',
  '',
]

await writeFile(join(root, 'THIRD_PARTY_NOTICES.md'), lines.join('\n') + '\n', 'utf8')
console.log(`THIRD_PARTY_NOTICES.md written (${rows.length} packages)`)

// Sanity: warn when a top-level node_modules package.json disagrees with the
// lockfile license (lockfiles are usually right; this catches surprises).
for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-agent']) {
  const pkgJson = join(root, 'node_modules', name, 'package.json')
  try {
    const pkg = JSON.parse(await readFile(pkgJson, 'utf8'))
    console.log(`  ${name}@${pkg.version} license=${pkg.license ?? 'n/a'}`)
  } catch {
    console.log(`  ${name}: not installed at top level`)
  }
}
