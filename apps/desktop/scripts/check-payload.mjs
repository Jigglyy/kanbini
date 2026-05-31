// ADR-0056 - post-package payload guard. Runs after `electron-builder`
// produces the installer; opens the NSIS payload + asserts every file
// we expected to ship is actually inside. Catches the "stale-installer
// trap" documented in ADR-0050 - `electron-builder.yml`'s
// `extraResources` was edited after the .exe was built, the installer
// shipped without the new files, and the bug only surfaced when a
// user installed and the app crashed looking for them.
//
// electron-builder has no built-in check for missing extraResources
// source paths (writes nothing + completes happily). This script is
// our backstop.
//
// Hooked into `pnpm --filter @kanbini/desktop run package` via the
// `postpackage` npm lifecycle hook (pnpm respects it). Skipped for
// `package:dir` since that produces an unpacked folder, not an
// installer with a payload to inspect.
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
  parsePathListing
} from './check-payload-core.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const RELEASE_DIR = resolve(here, '../release')

// Required sentinel paths inside the installer payload (relative to
// the `app-64.7z` root). Each one is something the app would fail
// catastrophically without:
//
//   - `resources/app.asar` is the main bundle. No app without it.
//   - `resources/NOTICES.md` carries third-party license notices;
//     missing it is a compliance bug (Settings → About reads it).
//   - `resources/mcp/index.js` is the MCP server bundle. Settings →
//     AI integration renders its absolute path; missing = broken
//     paste-into-AI-client config.
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
  'resources/drizzle/meta/_journal.json',
  'resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node'
]

// Locate 7-Zip. Well-known Windows install dir first because that's
// the path the user is almost certain to have (the PACKAGING.md
// stale-installer payload-sniff snippet hardcodes it there), then a
// PATH lookup as a fallback for CI / non-default installs. The script
// is Windows-only today because that's the only platform shipping an
// installer; Mac/Linux builds use different formats.
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

// Pick the most recently-built `Kanbini Setup *.exe`. There's usually
// only one but if multiple versions linger in release/ from earlier
// builds, the freshest one is what just came out of the current
// `package` run.
function findInstaller() {
  if (!existsSync(RELEASE_DIR)) {
    return {
      error: `release dir not found: ${RELEASE_DIR}. Run \`pnpm --filter @kanbini/desktop run package\` first.`
    }
  }
  const entries = readdirSync(RELEASE_DIR)
    .filter((n) => /^Kanbini Setup .+\.exe$/.test(n))
  if (entries.length === 0) {
    return {
      error: `no \`Kanbini Setup *.exe\` in ${RELEASE_DIR}. Run \`pnpm --filter @kanbini/desktop run package\` first.`
    }
  }
  const installer = entries
    .map((n) => ({
      name: n,
      full: join(RELEASE_DIR, n),
      mtime: statSync(join(RELEASE_DIR, n)).mtime
    }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())[0]
  return { installer }
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
  // Bug-fix: only Windows produces an NSIS Setup .exe today. Mac dmg
  // + Linux AppImage have different payload formats this script
  // doesn't know how to inspect. Skip cleanly (exit 0) on those
  // platforms - the build still succeeds, just without payload
  // verification. When a Mac/Linux release matters, add
  // platform-specific inspection paths here.
  if (process.platform !== 'win32') {
    console.log(
      `[check-payload] SKIP - only the Windows NSIS installer is checked (current platform: ${process.platform}).`
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

  const found = findInstaller()
  if (found.error) {
    console.error(`[check-payload] FAIL - ${found.error}`)
    process.exit(1)
  }
  const { installer } = found
  console.log(`[check-payload] inspecting ${installer.name}`)
  console.log(`[check-payload]   built: ${installer.mtime.toISOString()}`)

  const tmpDir = mkdtempSync(join(tmpdir(), 'kanbini-payload-'))
  // Bug-fix: initialize to 1 so an uncaught exception in the try
  // block can't silently exit 0 (which would let a script crash
  // pass through as build success). Only the explicit "OK" path
  // sets it to 0 before the try ends.
  let exitCode = 1
  try {
    // Step 1 - extract $PLUGINSDIR/app-64.7z from the NSIS installer.
    // NSIS wraps its payload as a 7z archive inside the .exe; 7z
    // recognises the .exe as a 7z-format SFX and can extract it.
    // No shell:true (see listPayloadPaths for the rationale). The
    // `$PLUGINSDIR/app-64.7z` argument is a path INSIDE the 7z archive,
    // not a shell variable - 7z interprets the literal string.
    const extract = spawnSync(
      sevenZ,
      ['e', '-y', `-o${tmpDir}`, installer.full, '$PLUGINSDIR/app-64.7z'],
      { encoding: 'utf8' }
    )
    if (extract.status !== 0) {
      console.error(
        `[check-payload] FAIL - couldn't extract \`$PLUGINSDIR/app-64.7z\` from ${installer.name}:`
      )
      console.error(extract.stderr)
      exitCode = 1
      return
    }
    const payloadArchive = join(tmpDir, 'app-64.7z')
    if (!existsSync(payloadArchive)) {
      console.error(
        `[check-payload] FAIL - expected ${payloadArchive} after extraction, not found.`
      )
      console.error(
        '[check-payload] The installer may use a different payload format than the NSIS default - investigate.'
      )
      exitCode = 1
      return
    }

    // Step 2 - list the payload's contents.
    const listed = listPayloadPaths(sevenZ, payloadArchive)
    if (listed.error) {
      console.error('[check-payload] FAIL - couldn\'t list app-64.7z contents:')
      console.error(listed.error)
      exitCode = 1
      return
    }
    console.log(`[check-payload]   payload entries: ${listed.present.size}`)

    // Step 3 - check every required sentinel is present.
    const missing = findMissingSentinels(listed.present, REQUIRED_SENTINELS)
    if (missing.length > 0) {
      console.error('')
      console.error(
        `[check-payload] FAIL - missing required sentinel${missing.length === 1 ? '' : 's'} in the installer payload:`
      )
      for (const m of missing) console.error(`  - ${m}`)
      console.error('')
      console.error(
        'Likely cause: `electron-builder.yml` was edited (extraResources / asarUnpack)'
      )
      console.error(
        'after the .exe was built, so the change never made it into the payload -'
      )
      console.error(
        'the stale-installer trap from ADR-0050. Rebuild:'
      )
      console.error(
        '  pnpm --filter @kanbini/desktop run package'
      )
      console.error(
        'and the guard should pass on the fresh artefact.'
      )
      exitCode = 1
      return
    }

    console.log(
      `[check-payload] OK - all ${REQUIRED_SENTINELS.length} required sentinels present.`
    )
    exitCode = 0
  } catch (e) {
    // Bug-fix: any uncaught exception in the try block should fail
    // the build, not silently exit 0. Initial exitCode is 1; the
    // catch keeps it 1 + prints the error so a script crash surfaces
    // clearly instead of being masked by the finally's process.exit.
    console.error('[check-payload] FAIL - unexpected error:')
    console.error(e instanceof Error ? e.stack ?? e.message : String(e))
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
    process.exit(exitCode)
  }
}

main()
