// Pretest hook for @kanbini/db. Vitest runs under Node, so the
// better-sqlite3 native binding has to be built against the active
// Node ABI. After running `pnpm dev` (which rebuilds for Electron's
// ABI) the binding doesn't match Node any more - Vitest's first
// `require('better-sqlite3')` throws NODE_MODULE_VERSION mismatch.
//
// Strategy: try to load the binding once. If it loads, the ABI is
// already right - exit 0 fast. If it throws an ABI error, re-fetch
// the prebuilt for the active Node version via prebuild-install
// (the package's own install script). Any other error is a real
// failure - bubble it up so we don't mask it.

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// packages/db/scripts/ → repo root.
const repoRoot = resolve(here, '../../..')
const require = createRequire(import.meta.url)

function fastCheck() {
  try {
    // better-sqlite3's require() is lazy - the .node binary is only
    // dlopen()'d on `new Database()`. So `require()` alone passes
    // even with a wrong-ABI binary. Instantiate to actually exercise
    // the binding.
    const Database = require('better-sqlite3')
    const db = new Database(':memory:')
    db.close()
    return { ok: true }
  } catch (err) {
    return { ok: false, err }
  }
}

const first = fastCheck()
if (first.ok) process.exit(0)
const msg = first.err && first.err.message ? first.err.message : String(first.err)
if (!/NODE_MODULE_VERSION/.test(msg)) {
  console.error('[ensure-node-abi] unexpected error loading better-sqlite3:')
  console.error(msg)
  process.exit(1)
}

console.log('[ensure-node-abi] ABI mismatch - re-fetching better-sqlite3 prebuilt for active Node…')

// Locate the hoisted better-sqlite3 install. node-linker=hoisted +
// pnpm => `node_modules/.pnpm/better-sqlite3@<v>/node_modules/better-sqlite3`.
// Glob by prefix so a version bump doesn't break this script.
const pnpmRoot = resolve(repoRoot, 'node_modules/.pnpm')
if (!existsSync(pnpmRoot)) {
  console.error('[ensure-node-abi] node_modules/.pnpm not found - run `pnpm install` first')
  process.exit(1)
}
const entry = readdirSync(pnpmRoot).find((d) => d.startsWith('better-sqlite3@'))
if (!entry) {
  console.error('[ensure-node-abi] better-sqlite3 not installed under .pnpm - run `pnpm install`')
  process.exit(1)
}
const bsqRoot = resolve(pnpmRoot, entry, 'node_modules/better-sqlite3')

// Retry on EBUSY - on Windows, a zombie Electron helper from a
// previous run can hold the .node file open for a few seconds after
// the main process exits. Usually clears within 2–5 s; 3 attempts
// with 2 s backoff covers the common case.
function rebuildOnce() {
  return spawnSync('npx', ['--no-install', 'prebuild-install'], {
    cwd: bsqRoot,
    stdio: 'inherit',
    shell: true
  })
}

let r = rebuildOnce()
for (let attempt = 1; attempt < 3 && r.status !== 0; attempt++) {
  console.log(`[ensure-node-abi] rebuild failed (likely a stale Electron helper holding the binary) - retry ${attempt}/2 in 2 s…`)
  // Synchronous sleep - Atomics.wait on a SharedArrayBuffer is the
  // boring portable trick.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000)
  r = rebuildOnce()
}
if (r.status !== 0) {
  console.error('[ensure-node-abi] prebuild-install failed (exit', r.status + ')')
  console.error('[ensure-node-abi] hint: `taskkill /f /im electron.exe` to clear stale helpers, then re-run')
  process.exit(r.status ?? 1)
}

const second = fastCheck()
if (second.ok) {
  console.log('[ensure-node-abi] ABI fixed.')
  process.exit(0)
}
console.error('[ensure-node-abi] still failing after rebuild:')
console.error(
  second.err && second.err.message ? second.err.message : String(second.err)
)
process.exit(1)
