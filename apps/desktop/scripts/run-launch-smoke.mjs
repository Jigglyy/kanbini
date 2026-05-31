// Wrapper for `pnpm run test:launch`. Builds main + spawns Electron
// with `--launch-smoke`, which boots the app just far enough to
// exercise the native binding + run migrations + open the control
// channel path, then exits 0/1. Catches the ABI flip-flop that
// silently breaks `pnpm dev` after running the db unit tests, plus
// any main-process startup crash or migration failure.
//
// Same env hygiene as run-round-trip.mjs: ELECTRON_RUN_AS_NODE has to
// be unset, otherwise `require('electron')` returns the binary path
// instead of the API and the first `app.*` access crashes.

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(here, '..')

const require = createRequire(import.meta.url)
const electronPath = require('electron')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(
  electronPath,
  [resolve(desktopRoot, 'out/main/index.js'), '--launch-smoke'],
  { stdio: 'inherit', env }
)

child.on('exit', (code) => {
  // Reap Electron helper processes (GPU, utility, network service)
  // that may survive main's app.exit() on Windows. As orphans of this
  // dead spawn they keep the better-sqlite3 .node file open, which
  // makes a subsequent `pnpm test` fail with EBUSY when the pretest
  // hook tries to swap the binary back to Node ABI. taskkill /F /T
  // walks the process tree from the spawn's pid.
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
      stdio: 'ignore'
    })
  }
  process.exit(code ?? 1)
})
