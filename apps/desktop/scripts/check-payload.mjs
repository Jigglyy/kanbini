// ADR-0056 - post-package payload guard. Runs after `electron-builder`
// produces the Windows release artifacts - the NSIS installer, the
// portable .zip (ADR-0071) and the one-file portable .exe (ADR-0073) -
// and asserts every file we expected to ship is actually inside ALL of
// them. Catches the "stale-installer trap" documented
// in ADR-0050 - `electron-builder.yml`'s `extraResources` was edited
// after the build, the artifact shipped without the new files, and the
// bug only surfaced when a user ran it and the app crashed looking for
// them.
//
// electron-builder has no built-in check for missing extraResources
// source paths (writes nothing + completes happily). This script is
// our backstop.
//
// On macOS and Linux it checks the unpacked app those platforms' release
// files are made from instead (see `UNPACKED`, ADR-0077).
//
// Hooked into `pnpm --filter @kanbini/desktop run package` via the
// `postpackage` npm lifecycle hook (pnpm respects it). Skipped for
// `package:dir` since that produces only the unpacked folder.
//
// Usage standalone: `node apps/desktop/scripts/check-payload.mjs`

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  findMissingSentinels,
  parsePathListing,
  toSentinelPath
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
// artifacts it can read; Mac/Linux builds use different formats.
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

// The newest file in release/ whose name matches `pattern`. There's
// usually only one per kind, but if older versions linger, the freshest
// is what the current `package` run just produced.
function findNewest(pattern, label) {
  if (!existsSync(RELEASE_DIR)) {
    return {
      error: `release dir not found: ${RELEASE_DIR}. Run \`pnpm --filter @kanbini/desktop run package\` first.`
    }
  }
  const entries = readdirSync(RELEASE_DIR).filter((n) => pattern.test(n))
  if (entries.length === 0) {
    return {
      error: `no ${label} in ${RELEASE_DIR}. Run \`pnpm --filter @kanbini/desktop run package\` first.`
    }
  }
  const file = entries
    .map((n) => ({
      name: n,
      full: join(RELEASE_DIR, n),
      mtime: statSync(join(RELEASE_DIR, n)).mtime
    }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())[0]
  return { file }
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

// The zip holds the unpacked app directly (Kanbini.exe, resources/, ...),
// so its sentinels list straight out of it.
function zipPaths(sevenZ, file) {
  return listPayloadPaths(sevenZ, file.full)
}

// The NSIS installer AND the one-file portable .exe (both NSIS) wrap
// their payload as a 7z archive inside the .exe; 7z recognises the .exe
// as a 7z-format SFX, so extract `$PLUGINSDIR/app-64.7z` (a path INSIDE
// the archive, not a shell variable) to a temp dir and list that.
function nsisPayloadPaths(sevenZ, file) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'kanbini-payload-'))
  try {
    const extract = spawnSync(
      sevenZ,
      ['e', '-y', `-o${tmpDir}`, file.full, '$PLUGINSDIR/app-64.7z'],
      { encoding: 'utf8' }
    )
    if (extract.status !== 0) {
      return {
        error: `couldn't extract \`$PLUGINSDIR/app-64.7z\`:\n${extract.stderr}`
      }
    }
    const payload = join(tmpDir, 'app-64.7z')
    if (!existsSync(payload)) {
      return {
        error: `expected ${payload} after extraction, not found - the installer may use a different payload format than the NSIS default.`
      }
    }
    return listPayloadPaths(sevenZ, payload)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

const ARTIFACTS = [
  {
    label: '`Kanbini Setup *.exe` (installer)',
    pattern: /^Kanbini Setup .+\.exe$/,
    list: nsisPayloadPaths
  },
  {
    label: '`Kanbini-*-win-*-portable.zip` (portable folder)',
    pattern: /^Kanbini-.+-win-.+-portable\.zip$/,
    list: zipPaths
  },
  {
    label: '`Kanbini-*-win-*-portable-single-file.exe` (one-file portable)',
    pattern: /^Kanbini-.+-win-.+-portable-single-file\.exe$/,
    list: nsisPayloadPaths
  }
]

/** Check one artifact; returns true when every sentinel is present. */
function checkArtifact(sevenZ, { label, pattern, list }) {
  const found = findNewest(pattern, label)
  if (found.error) {
    console.error(`[check-payload] FAIL - ${found.error}`)
    return false
  }
  const { file } = found
  console.log(`[check-payload] inspecting ${file.name}`)
  console.log(`[check-payload]   built: ${file.mtime.toISOString()}`)

  const listed = list(sevenZ, file)
  if (listed.error) {
    console.error(`[check-payload] FAIL - couldn't list ${file.name}:`)
    console.error(listed.error)
    return false
  }
  console.log(`[check-payload]   payload entries: ${listed.present.size}`)
  return reportSentinels(file.name, listed.present)
}

/** Diff a payload listing against REQUIRED_SENTINELS and print the
 *  verdict; returns true when every sentinel is present. */
function reportSentinels(name, present) {
  const missing = findMissingSentinels(present, REQUIRED_SENTINELS)
  if (missing.length > 0) {
    console.error('')
    console.error(
      `[check-payload] FAIL - missing required sentinel${missing.length === 1 ? '' : 's'} in ${name}:`
    )
    for (const m of missing) console.error(`  - ${m}`)
    console.error('')
    console.error(
      'Likely cause: `electron-builder.yml` was edited (extraResources / asarUnpack)'
    )
    console.error(
      'after the build, so the change never made it into the artifact -'
    )
    console.error('the stale-installer trap from ADR-0050. Rebuild:')
    console.error('  pnpm --filter @kanbini/desktop run package')
    console.error('and the guard should pass on the fresh artefact.')
    return false
  }
  console.log(
    `[check-payload]   OK - all ${REQUIRED_SENTINELS.length} required sentinels present.`
  )
  return true
}

// macOS + Linux (ADR-0077). Their release files (.dmg, AppImage, .deb)
// are all made from the unpacked app electron-builder leaves in
// release/ during the same run, so walk that folder for the sentinels
// and confirm each release file was written. Reading inside a .dmg
// (hdiutil attach) or an AppImage (squashfs) isn't worth the moving
// parts when both are built from this folder seconds later.
const UNPACKED = {
  darwin: {
    label: 'mac-universal/Kanbini.app',
    root: join(RELEASE_DIR, 'mac-universal', 'Kanbini.app', 'Contents'),
    artifacts: [
      {
        label: '`Kanbini-*-mac-universal.dmg`',
        pattern: /^Kanbini-.+-mac-universal\.dmg$/
      }
    ]
  },
  linux: {
    label: 'linux-unpacked',
    root: join(RELEASE_DIR, 'linux-unpacked'),
    artifacts: [
      {
        label: '`Kanbini-*-linux-x86_64.AppImage`',
        pattern: /^Kanbini-.+-linux-x86_64\.AppImage$/
      },
      {
        label: '`Kanbini-*-linux-amd64.deb`',
        pattern: /^Kanbini-.+-linux-amd64\.deb$/
      }
    ]
  }
}

/** Every path under `root`, relative and in sentinel spelling.
 *  Symlinks (the .app's framework `Versions/Current` links) are listed
 *  but not followed. */
function listTree(root) {
  const present = new Set()
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name
      present.add(toSentinelPath(path))
      if (entry.isDirectory()) walk(join(dir, entry.name), path)
    }
  }
  walk(root, '')
  return present
}

function checkUnpacked({ label, root, artifacts }) {
  let ok = true
  for (const a of artifacts) {
    const found = findNewest(a.pattern, a.label)
    if (found.error) {
      console.error(`[check-payload] FAIL - ${found.error}`)
      ok = false
    } else {
      console.log(
        `[check-payload] found ${found.file.name} (built ${found.file.mtime.toISOString()})`
      )
    }
  }
  if (!existsSync(root)) {
    console.error(`[check-payload] FAIL - unpacked app not found: ${root}`)
    return false
  }
  console.log(`[check-payload] inspecting ${label}`)
  if (!reportSentinels(label, listTree(root))) ok = false
  return ok
}

function main() {
  const unpacked = UNPACKED[process.platform]
  if (unpacked) {
    const ok = checkUnpacked(unpacked)
    if (ok) console.log(`[check-payload] OK - ${process.platform} release files complete.`)
    process.exit(ok ? 0 : 1)
  }
  if (process.platform !== 'win32') {
    console.log(
      `[check-payload] SKIP - no release check for this platform (${process.platform}).`
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

  let ok = true
  for (const artifact of ARTIFACTS) {
    try {
      // Check every artifact even after a failure, so one run reports
      // everything that's wrong.
      if (!checkArtifact(sevenZ, artifact)) ok = false
    } catch (e) {
      // Any unexpected error fails the build rather than slipping
      // through as a pass.
      console.error('[check-payload] FAIL - unexpected error:')
      console.error(e instanceof Error ? e.stack ?? e.message : String(e))
      ok = false
    }
  }
  if (ok) console.log('[check-payload] OK - installer, portable .zip and one-file .exe all complete.')
  process.exit(ok ? 0 : 1)
}

main()
