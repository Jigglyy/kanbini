// M5-B / ADR-0054 - generate NOTICES.md from the production
// dependency tree.
//
// Walks every package in the production-only dependency closure of
// `@kanbini/desktop`, `@kanbini/renderer`, and `@kanbini/mcp` (the
// three workspaces that ship inside the installer). For each
// package, reproduces:
//   - Name + version + SPDX license identifier + author/homepage
//   - The package's own LICENSE file verbatim
//   - The package's NOTICE file too, if Apache-2.0 requires one
//
// Output: `<repo-root>/NOTICES.md` - committed to the repo so a
// fresh clone can package without re-running this script, and
// shipped under `resources/NOTICES.md` in the packaged app via
// electron-builder's `extraResources` so users can read it through
// Settings → About → Third-party notices (and so the legal
// reproduction requirement is satisfied at the binary).
//
// Pure JS, zero new deps. Re-run after `pnpm install` whenever a
// dep is added/removed/bumped; the diff is the audit trail.
//
// Usage: `pnpm --filter @kanbini/desktop run build:notices`

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(here, '../../..')
const OUTPUT = join(REPO_ROOT, 'NOTICES.md')

// Common filenames packages use for license/notice text. Match
// case-insensitively (some packages use README.md as the license
// container, which we deliberately skip).
const LICENSE_FILES = ['license', 'license.txt', 'license.md', 'licence', 'licence.txt', 'licence.md']
const NOTICE_FILES = ['notice', 'notice.txt', 'notice.md']

function findFile(dir, candidates) {
  if (!existsSync(dir)) return null
  const entries = readdirSync(dir)
  for (const entry of entries) {
    if (candidates.includes(entry.toLowerCase())) {
      return join(dir, entry)
    }
  }
  return null
}

function runPnpmLicenses() {
  // --prod limits to runtime deps (excludes vitest, typescript,
  // electron-builder, tailwindcss - none of which ship inside the
  // installer). The three --filter args constrain to the
  // shippable workspace closures.
  const result = spawnSync(
    'pnpm',
    [
      'licenses', 'list', '--prod', '--json',
      '--filter', '@kanbini/desktop...',
      '--filter', '@kanbini/renderer...',
      '--filter', '@kanbini/mcp...'
    ],
    { cwd: REPO_ROOT, encoding: 'utf8', shell: process.platform === 'win32' }
  )
  if (result.status !== 0) {
    console.error('pnpm licenses list failed:', result.stderr)
    process.exit(1)
  }
  return JSON.parse(result.stdout)
}

// Normalise pnpm's "(MIT OR WTFPL)" style → pick the most-common
// permissive option so the family grouping doesn't end up with
// one-off categories like "(MIT OR WTFPL)" with a single member.
function canonicalLicense(raw) {
  if (!raw.includes('(') && !raw.includes(' OR ')) return raw
  const options = raw.replace(/[()]/g, '').split(/\s+OR\s+/)
  const priority = ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'BSD-2-Clause', 'ISC', '0BSD']
  for (const p of priority) {
    if (options.includes(p)) return p
  }
  return options[0]
}

function loadPackageMeta(pkgPath) {
  const pkgJsonPath = join(pkgPath, 'package.json')
  if (!existsSync(pkgJsonPath)) return null
  try {
    return JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
  } catch {
    return null
  }
}

function formatPackageEntry(pkg) {
  const meta = loadPackageMeta(pkg.path)
  const author = meta?.author
    ? typeof meta.author === 'string' ? meta.author : meta.author.name
    : pkg.author ?? null
  const homepage = meta?.homepage ?? pkg.homepage ?? null
  const licensePath = findFile(pkg.path, LICENSE_FILES)
  const noticePath = findFile(pkg.path, NOTICE_FILES)

  const out = [`### ${pkg.name} ${pkg.version}`, '']
  if (author) out.push(`- Author: ${author}`)
  if (homepage) out.push(`- Homepage: ${homepage}`)
  out.push(`- License: ${pkg.license}`)
  out.push('')

  if (licensePath) {
    out.push('```')
    out.push(readFileSync(licensePath, 'utf8').trimEnd())
    out.push('```')
  } else {
    out.push(`> (No LICENSE file present in the published package - distributed under ${pkg.license}.)`)
  }

  if (noticePath) {
    out.push('')
    out.push('Additional NOTICE:')
    out.push('')
    out.push('```')
    out.push(readFileSync(noticePath, 'utf8').trimEnd())
    out.push('```')
  }

  return out.join('\n')
}

function main() {
  console.log('[build-notices] Querying pnpm licenses list…')
  const raw = runPnpmLicenses()

  // Flatten to (license, name, version, path, …) entries +
  // re-group under canonical license names so compound SPDX
  // expressions collapse into their chosen family.
  const flat = []
  for (const [_rawLicense, pkgs] of Object.entries(raw)) {
    for (const pkg of pkgs) {
      // pnpm lists each version on a separate entry, sometimes
      // with multiple paths if the same version appears in
      // multiple peer-resolution shapes - pick the first.
      const license = canonicalLicense(pkg.license || _rawLicense)
      for (const version of pkg.versions) {
        flat.push({
          name: pkg.name,
          version,
          license,
          path: pkg.paths?.[0] ?? null,
          author: pkg.author ?? null,
          homepage: pkg.homepage ?? null
        })
      }
    }
  }

  // De-duplicate (name + version) - multiple workspace filters can
  // surface the same dep twice.
  const seen = new Set()
  const unique = flat.filter((p) => {
    const key = `${p.name}@${p.version}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  unique.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))

  const byLicense = new Map()
  for (const p of unique) {
    if (!byLicense.has(p.license)) byLicense.set(p.license, [])
    byLicense.get(p.license).push(p)
  }

  // Stable ordering: most-common license first.
  const families = [...byLicense.entries()].sort((a, b) => b[1].length - a[1].length)

  const lines = []
  lines.push('# Kanbini - Third-Party Notices')
  lines.push('')
  lines.push('Kanbini bundles third-party open-source software. Each package below')
  lines.push('is used under the terms of its own license, reproduced verbatim from')
  lines.push("the package's `LICENSE` file (and `NOTICE` if Apache-2.0 requires one).")
  lines.push('')
  lines.push('This file is generated by `pnpm --filter @kanbini/desktop run build:notices`')
  lines.push('against the production dependency closure of the three shippable')
  lines.push('workspaces (`@kanbini/desktop`, `@kanbini/renderer`, `@kanbini/mcp`).')
  lines.push('DevDependencies - vitest, typescript, electron-builder, tailwindcss,')
  lines.push("and the rest - don't ship inside the installer and aren't listed here.")
  lines.push('')
  lines.push('## Summary')
  lines.push('')
  lines.push(`Total packages: **${unique.length}**`)
  lines.push('')
  lines.push('| License | Count |')
  lines.push('|---|---|')
  for (const [lic, pkgs] of families) {
    lines.push(`| ${lic} | ${pkgs.length} |`)
  }
  lines.push('')

  for (const [lic, pkgs] of families) {
    lines.push('---')
    lines.push('')
    lines.push(`## ${lic} (${pkgs.length} package${pkgs.length === 1 ? '' : 's'})`)
    lines.push('')
    for (const pkg of pkgs) {
      lines.push(formatPackageEntry(pkg))
      lines.push('')
    }
  }

  writeFileSync(OUTPUT, lines.join('\n'))
  console.log(`[build-notices] Wrote ${OUTPUT}`)
  console.log(`[build-notices] ${unique.length} packages across ${families.length} license families`)
}

main()
