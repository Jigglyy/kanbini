import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Pretest hook for apps/desktop-e2e. Ensures the desktop app is
// freshly built + better-sqlite3 is rebuilt for Electron's Node ABI
// before Playwright launches it. Mirrors the same flow used by
// `pnpm --filter @kanbini/desktop run test:launch` (the launch
// smoke) - both layers want the same prerequisites.

const here = dirname(fileURLToPath(import.meta.url))
// scripts/prepare.mjs → apps/desktop
const DESKTOP = resolve(here, '../../desktop')

function run(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: DESKTOP,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  if (result.status !== 0) {
    console.error(`[e2e:prepare] ${cmd} ${args.join(' ')} exited ${result.status}`)
    process.exit(result.status ?? 1)
  }
}

// 1. ABI alignment - same script the dev/launch-smoke paths use.
run('node', ['scripts/ensure-electron-abi.mjs'])

// 2. electron-vite build → out/main + out/preload + out/renderer.
// Skipped when the build artifacts already exist AND nothing in
// apps/desktop/src or the renderer has changed since. Hard to detect
// reliably in a small shell script, so always rebuild - keeps the
// E2E pretest from staling on stale builds. ~2-3 s incrementally.
run('pnpm', ['exec', 'electron-vite', 'build'])

// Sanity - the launcher needs this entry to exist.
const mainEntry = resolve(DESKTOP, 'out/main/index.js')
if (!existsSync(mainEntry)) {
  console.error(`[e2e:prepare] build finished but ${mainEntry} is missing`)
  process.exit(1)
}
console.log(`[e2e:prepare] ready - main entry at ${mainEntry}`)
