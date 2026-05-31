// Predev hook for @kanbini/desktop. The better-sqlite3 native binding
// has to be built against Electron's Node ABI to be loadable in the
// app's main process. After running `pnpm test` (which rebuilds the
// binding for the active Node), the first `pnpm dev` would hit the
// dreaded NODE_MODULE_VERSION mismatch - main throws before reaching
// the window. This script prevents that:
//   1. Spawn Electron with abi-probe.cjs to confirm the binding loads
//      (fast - ~500 ms when correct).
//   2. On failure, run electron-rebuild -f to switch the binding to
//      Electron's ABI.
//   3. Re-probe to confirm the fix took. Exit final code.
//
// ELECTRON_RUN_AS_NODE has to be unset, see the run-round-trip note.

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(here, '..')
const probe = resolve(here, 'abi-probe.cjs')

const require = createRequire(import.meta.url)
const electronPath = require('electron')

function runProbe() {
  return new Promise((res) => {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    // Swallow stderr from the probe on the happy path so a clean
    // launch is silent; surface it via the final console.error if
    // we end up failing.
    const child = spawn(electronPath, [probe], { env, stdio: 'ignore' })
    child.on('exit', (code) => {
      // Same Windows orphan-reap as run-launch-smoke.mjs: Electron
      // helpers can outlive app.exit() and hold the .node binary
      // open, breaking the next ABI swap. taskkill /F /T cleans the
      // tree so back-to-back invocations stay reliable.
      if (process.platform === 'win32' && child.pid) {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
          stdio: 'ignore'
        })
      }
      res(code ?? 1)
    })
  })
}

const first = await runProbe()
if (first === 0) process.exit(0)

console.log('[ensure-electron-abi] ABI mismatch - rebuilding better-sqlite3 for Electron…')
// Resolve @electron/rebuild's CLI entry directly so we don't depend on
// pnpm being on PATH (and dodge the shell:true deprecation warning).
// `exports` is a plain string ("./lib/main.js") which blocks every
// other subpath including package.json. Use the main entry to find
// the package root, then point at the bin file alongside it.
const mainUrl = await import.meta.resolve('@electron/rebuild')
const electronRebuildBin = resolve(
  fileURLToPath(mainUrl),
  '../cli.js'
)
const rebuild = spawnSync(
  process.execPath,
  [electronRebuildBin, '-f', '-w', 'better-sqlite3'],
  { cwd: desktopRoot, stdio: 'inherit' }
)
if (rebuild.status !== 0) {
  console.error('[ensure-electron-abi] rebuild failed')
  process.exit(rebuild.status ?? 1)
}

const second = await runProbe()
if (second === 0) {
  console.log('[ensure-electron-abi] ABI fixed.')
  process.exit(0)
}
console.error(
  '[ensure-electron-abi] still failing after rebuild - run `pnpm --filter @kanbini/desktop test:launch` for details'
)
process.exit(second)
