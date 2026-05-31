import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// `pnpm e2e:headed` shim - sets KANBINI_E2E_HEADED=1 so the launcher
// in tests/_launch.ts skips its default `KANBINI_E2E_HEADLESS=1`,
// then spawns Playwright. Cross-platform without a `cross-env` dep
// (pnpm scripts can't set env vars portably; PowerShell uses
// `$env:NAME=...`, POSIX shells use `NAME=...` prefix).
//
// Use this when you want to actually WATCH a spec run (debugging a
// flake, recording a demo). Day-to-day `pnpm e2e` should stay
// headless so the windows don't pop up + steal focus.

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '..')

// Mirror prepare.mjs's `pnpm exec` pattern so the Playwright bin is
// resolved through the workspace's node_modules regardless of how the
// dev launched the script (works the same under `pnpm e2e:headed`,
// `pnpm --filter ... run e2e:headed`, and direct `node` invocation).
const env = { ...process.env, KANBINI_E2E_HEADED: '1' }
const child = spawn(
  'pnpm',
  ['exec', 'playwright', 'test', ...process.argv.slice(2)],
  {
    cwd: ROOT,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  }
)

child.on('exit', (code) => process.exit(code ?? 1))
