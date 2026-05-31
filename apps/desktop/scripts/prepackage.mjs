#!/usr/bin/env node
// Packaging pre-flight (M5-A, ADR-0039). One script chained from the
// `package` / `package:dir` npm-script so a packaged build always
// includes a fresh main+preload+renderer bundle, a fresh MCP bundle
// (shipped under resources/mcp/), and a `better-sqlite3` native
// binding compiled for the Electron 41 ABI - not the active Node ABI.
//
// Why a separate script and not a chained npm-script (`A && B && C`)?
//  - Cross-platform: PowerShell + cmd + bash all parse chains
//    differently, but a single `node` invocation works everywhere
//    Electron itself runs (CI included).
//  - The three steps are independent enough that a clear log per step
//    helps when packaging fails - the npm `&&` chain swallows which
//    step failed under some shells.
//  - Future hooks (license inventory, NOTICES build, asset
//    optimization) drop in here without growing the script field.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(here, '..')
const repoRoot = resolve(desktopRoot, '../..')

function run(label, cmd, args, opts = {}) {
  console.log(`\n[prepackage] ${label}`)
  console.log(`[prepackage] $ ${cmd} ${args.join(' ')}`)
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    cwd: opts.cwd ?? repoRoot,
    shell: process.platform === 'win32',
    env: opts.env ?? process.env
  })
  if (res.status !== 0) {
    console.error(`[prepackage] ${label} failed (exit ${res.status})`)
    process.exit(res.status ?? 1)
  }
}

// 1. Build the MCP stdio bundle so it can ride along under
// resources/mcp/ via electron-builder's `extraResources` rule.
// Doing it first means a clean app + a known-good MCP bundle ship
// together - there's no scenario where the installer carries a stale
// MCP from a previous packaging attempt.
run('Building MCP bundle', 'pnpm', [
  '--filter',
  '@kanbini/mcp',
  'run',
  'build'
])
const mcpDist = resolve(repoRoot, 'apps/mcp/dist/index.js')
if (!existsSync(mcpDist)) {
  console.error(`[prepackage] MCP bundle not found at ${mcpDist}`)
  process.exit(1)
}

// The committed Drizzle migrations ship under <resources>/drizzle/
// (electron-builder.yml extraResources). `openDatabase` runs them on
// first launch + every schema bump - a missing folder crashes the
// packaged app's first SQL call. Always present in a fresh checkout,
// but the existence check costs nothing and catches a renamed-folder
// regression instantly.
const drizzleMigrations = resolve(repoRoot, 'packages/db/drizzle')
if (!existsSync(drizzleMigrations)) {
  console.error(
    `[prepackage] Drizzle migrations not found at ${drizzleMigrations}`
  )
  process.exit(1)
}

// 2. Flip `better-sqlite3` to the Electron ABI. The dev `predev` hook
// already does this for `pnpm dev`; tests flip it to Node ABI and back.
// Re-flip here so packaging never picks up a Node-ABI binding (it would
// crash on first SQL call in the packaged app - the Electron runtime
// can't load Node-ABI native modules).
run('Ensuring Electron ABI for better-sqlite3', 'node', [
  resolve(desktopRoot, 'scripts/ensure-electron-abi.mjs')
])

// 3. Build main + preload + renderer (electron-vite emits to `out/`).
// electron-builder reads `out/` via the `files` glob in
// electron-builder.yml + the `main` field in package.json.
run('Building main + preload + renderer', 'pnpm', [
  '--filter',
  '@kanbini/desktop',
  'run',
  'build'
])

console.log('\n[prepackage] All pre-flight steps OK - handing off to electron-builder.')
