// ADR-0056 - post-package payload guard. Runs after `electron-builder`
// produces the release artifact (the portable .zip since ADR-0071; the
// NSIS installer before it) and asserts every file we expected to ship
// is actually inside. Catches the "stale-installer trap" documented in
// ADR-0050 - `electron-builder.yml`'s `extraResources` was edited after
// the build, the artifact shipped without the new files, and the bug
// only surfaced when a user ran it and the app crashed looking for them.
//
// electron-builder has no built-in check for missing extraResources
// source paths (writes nothing + completes happily). This script is
// our backstop.
//
// Hooked into `pnpm --filter @kanbini/desktop run package` via the
// `postpackage` npm lifecycle hook (pnpm respects it). Skipped for
// `package:dir` since that produces only the unpacked folder.
//
// Usage standalone: `node apps/desktop/scripts/check-payload.mjs`

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  findMissingSentinels,
  parsePathListing
} from './check-payload-core.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const RELEASE_DIR = resolve(here, '../release')

// Required sentinel paths inside the artifact (relative to the
// unpacked app's root). Each one is something the app would fail
// catastrophically without:
//
//   - `resources/app.asar` is the main bundle. No app without it.
//   - `resources/NOTICES.md` carries third-party license notices;
//     missing it is a compliance bug (Settings → About reads it).
//   - `resources/mcp/index.js` is the MCP server bundle. Settings →
//     AI integration renders its absolute path; missing = broken
//     paste-into-AI-client config.
//   - `resources/mcp/package.json` is the `{"type":"module"}` marker
//     tsup emits next to the bundle. The bundle is ESM and nothing
//     above `resources/mcp/` declares a module type, so without it
//     Node treats index.js as CommonJS and the server dies on its
//     first `import` (v0.7.1 shipped that way; clients reported the
//     opaque CONNECTION_CLOSED). Presence-only check - that the
//     bundle is genuinely self-contained is pinned by
//     apps/mcp/src/__tests__/bundle-standalone.test.ts.
//   - `resources/drizzle/meta/_journal.json` is the migration
//     manifest. The exact file that bit us in the stale-installer
//     trap (ADR-0050) - main crashes at openDatabase() without it.
//   - `resources/app.asar.unpacked/.../better_sqlite3.node` is the
//     native binding. Node can't dlopen from inside an asar archive
//     so it lives unpacked; missing = openDatabase() throws.
//
// Add to this list when a new extraResources / asarUnpack path lands
// in electron-builder.yml.
const REQUIRED_SENTINELS = [
  'resources/app.asar',
  'resources/NOTICES.md',
  'resources/mcp/index.js',
  'resources/mcp/package.json',
  'resources/drizzle/meta/_journal.json',
  'resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node'
]

// Locate 7-Zip. Well-known Windows install dir first because that's
// the path the user is almost certain to have (the PACKAGING.md
// stale-installer payload-sniff snippet hardcodes it there), then a
// PATH lookup as a fallback for CI / non-default installs. The script
// is Windows-only today because that's the only platform whose
// artifact it can read; Mac/Linux builds use different formats.
function find7z() {
  const wellKnown = 'C:\\Program Files\\7-Zip\\7z.exe'
  if (existsSync(wellKnown)) return wellKnown
  // PATH lookup WITHOUT shell:true so a missing binary surfaces as
  // ENOENT (r.error set, r.status === null) rather than as cmd.exe's
  // shell-level exit-1 (which would false-positive as "found").
  for (const cmd of ['7z.exe', '7z']) {
    const r = spawnSync(cmd, ['--help'], { stdio: 'ignore' })
    if (!r.error && r.status !== null) return cmd
  }
  return null
}

// Pick the most recently-built `Kanbini-*-win-*.zip` (the portable
// folder, ADR-0071). There's usually only one but if older versions
// linger in release/, the freshest one is what the current `package`
// run just produced.
function findArtifact() {
  if (!existsSync(RELEASE_DIR)) {
    return {
      error: `release dir not found: ${RELEASE_DIR}. Run \`pnpm --filter @kanbini/desktop run package\` first.`
    }
  }
  const entries = readdirSync(RELEASE_DIR)
    .filter((n) => /^Kanbini-.+-win-.+\.zip$/.test(n))
  if (entries.length === 0) {
    return {
      error: `no \`Kanbini-*-win-*.zip\` in ${RELEASE_DIR}. Run \`pnpm --filter @kanbini/desktop run package\` first.`
    }
  }
  const artifact = entries
    .map((n) => ({
      name: n,
      full: join(RELEASE_DIR, n),
      mtime: statSync(join(RELEASE_DIR, n)).mtime
    }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())[0]
  return { artifact }
}

// Run `7z l -slt <file>` and hand the stdout to `parsePathListing`
// (pure helper in check-payload-core.mjs, unit-tested separately).
function listPayloadPaths(sevenZ, archive) {
  // No shell:true - the 7z path may contain spaces (the default
  // Windows install is `C:\Program Files\7-Zip\7z.exe`) which cmd.exe
  // splits on. spawnSync without a shell passes the path as a single
  // argv[0] and Windows resolves it correctly.
  const r = spawnSync(sevenZ, ['l', '-slt', archive], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024 // 32 MB - payload listings can be long
  })
  if (r.status !== 0) {
    return { error: r.stderr || `7z exited with ${r.status}` }
  }
  return { present: parsePathListing(r.stdout) }
}

function main() {
  // Only the Windows portable .zip is inspected today. Mac dmg + Linux
  // AppImage have different payload formats this script doesn't know
  // how to read. Skip cleanly (exit 0) on those platforms - the build
  // still succeeds, just without payload verification.
  if (process.platform !== 'win32') {
    console.log(
      `[check-payload] SKIP - only the Windows portable .zip is checked (current platform: ${process.platform}).`
    )
    process.exit(0)
  }

  const sevenZ = find7z()
  if (!sevenZ) {
    console.error('[check-payload] FAIL - 7z not found.')
    console.error(
      '[check-payload] install 7-Zip (https://www.7-zip.org/) and ensure it\'s on PATH'
    )
    console.error(
      '[check-payload] or installed at the default `C:\\Program Files\\7-Zip\\7z.exe`.'
    )
    process.exit(1)
  }

  const found = findArtifact()
  if (found.error) {
    console.error(`[check-payload] FAIL - ${found.error}`)
    process.exit(1)
  }
  const { artifact } = found
  console.log(`[check-payload] inspecting ${artifact.name}`)
  console.log(`[check-payload]   built: ${artifact.mtime.toISOString()}`)

  // The zip holds the unpacked app directly (Kanbini.exe, resources/,
  // ...), so the sentinels are listed straight out of it - no inner
  // payload archive to extract first, unlike the old NSIS installer.
  const listed = listPayloadPaths(sevenZ, artifact.full)
  if (listed.error) {
    console.error(`[check-payload] FAIL - couldn't list ${artifact.name}:`)
    console.error(listed.error)
    process.exit(1)
  }
  console.log(`[check-payload]   payload entries: ${listed.present.size}`)

  const missing = findMissingSentinels(listed.present, REQUIRED_SENTINELS)
  if (missing.length > 0) {
    console.error('')
    console.error(
      `[check-payload] FAIL - missing required sentinel${missing.length === 1 ? '' : 's'} in ${artifact.name}:`
    )
    for (const m of missing) console.error(`  - ${m}`)
    console.error('')
    console.error(
      'Likely cause: `electron-builder.yml` was edited (extraResources / asarUnpack)'
    )
    console.error(
      'after the build, so the change never made it into the artifact -'
    )
    console.error('the stale-build trap from ADR-0050. Rebuild:')
    console.error('  pnpm --filter @kanbini/desktop run package')
    console.error('and the guard should pass on the fresh artefact.')
    process.exit(1)
  }

  console.log(
    `[check-payload] OK - all ${REQUIRED_SENTINELS.length} required sentinels present.`
  )
  process.exit(0)
}

main()
