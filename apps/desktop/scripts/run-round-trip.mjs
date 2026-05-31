// Wrapper for `pnpm run test:roundtrip`. Spawns electron with
// ELECTRON_RUN_AS_NODE explicitly cleared - without that, an env var
// inherited from the parent (notably Claude Code's launch context)
// would make electron behave like a plain Node, in which case
// `require('electron')` returns the binary path and the round-trip
// entry point crashes on the first `app.*` access.
//
// Resolves the electron binary via the `electron` npm package so this
// stays cross-platform (no hardcoded `.exe`).

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(here, '..')

const require = createRequire(import.meta.url)
const electronPath = require('electron') // returns the executable path

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(
  electronPath,
  [resolve(desktopRoot, 'out/main/index.js'), '--round-trip-test'],
  { stdio: 'inherit', env }
)

child.on('exit', (code) => {
  process.exit(code ?? 1)
})
