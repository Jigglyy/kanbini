import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Launch helper used by every E2E spec. Boots a clean Electron app
// against a temp userData directory so tests are isolated from each
// other AND from the developer's real Kanbini data. Caller is
// responsible for `await handle.cleanup()` in test teardown.

const here = dirname(fileURLToPath(import.meta.url))
// tests/_launch.ts → apps/desktop/out/main/index.js
const MAIN_ENTRY = resolve(here, '../../desktop/out/main/index.js')

export interface E2EHandle {
  app: ElectronApplication
  page: Page
  userDataDir: string
  cleanup: () => Promise<void>
}

export interface LaunchOptions {
  /** Extra env vars to forward to the Electron child. Tests use this
   *  to set KANBINI_E2E_DIALOG_FILE / KANBINI_E2E_DIALOG_DIR so the
   *  native open-file / open-folder dialogs return a fixed path
   *  (Playwright can't drive native dialogs). */
  env?: Record<string, string>
  /** Pre-allocated userData dir. Use this when the test needs to
   *  know the path BEFORE launch - e.g., the backup/restore flow
   *  needs to set KANBINI_E2E_DIALOG_DIR to `<userData>/export`,
   *  which means the userData path must exist before the env is
   *  built. The launcher still owns cleanup. */
  userDataDir?: string
}

export async function launchKanbini(
  options: LaunchOptions = {}
): Promise<E2EHandle> {
  // mkdtemp returns an absolute path with a unique suffix; cleanup
  // removes the tree after the app exits.
  const userDataDir =
    options.userDataDir ??
    (await mkdtemp(join(tmpdir(), 'kanbini-e2e-')))

  // Clone process.env minus ELECTRON_RUN_AS_NODE - Claude Code's
  // shell + some CI environments set it, which forces Electron to
  // boot as a plain Node and reject Chromium CLI flags Playwright
  // hands it (`--remote-debugging-port=0` etc.). Same gotcha the
  // round-trip runner has - see [[electron-cli-runner-env]] memory.
  //
  // The env passed to electron.launch is typed `{ [key: string]:
  // string }`, so strip undefined values from process.env first.
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && k !== 'ELECTRON_RUN_AS_NODE') {
      env[k] = v
    }
  }
  env['KANBINI_USERDATA_OVERRIDE'] = userDataDir
  // Force the renderer's `useSettings` system-theme listener into a
  // deterministic path; some Playwright matchMedia setups otherwise
  // flip live during the run.
  env['NODE_ENV'] = 'development'
  // Hide the Electron window by default - Playwright drives the
  // page over CDP regardless of visibility, so tests pass
  // identically but the windows don't pop up and steal focus from
  // whatever the dev is doing on their machine. Opt out with
  // KANBINI_E2E_HEADED=1 (handy when you want to actually watch a
  // failing spec play out). The env var is also forwarded if the
  // caller already set KANBINI_E2E_HEADLESS, so CI/xvfb setups that
  // pre-set it don't get double-flipped.
  if (process.env['KANBINI_E2E_HEADED'] !== '1') {
    env['KANBINI_E2E_HEADLESS'] = '1'
  }
  // Per-test extras (dialog overrides etc.) last so they win over
  // any conflicting inherited value.
  if (options.env) {
    for (const [k, v] of Object.entries(options.env)) {
      env[k] = v
    }
  }

  const app = await electron.launch({
    args: [MAIN_ENTRY],
    env
  })

  // Wait for the first BrowserWindow to appear. Electron may open a
  // splash before the main window in the future - `firstWindow` is
  // fine today since we have exactly one window.
  const page = await app.firstWindow()
  // Give the renderer a moment to mount React + run its first paint.
  // The harness uses `expect(...).toBeVisible({timeout})` for actual
  // synchronisation; this just unblocks the cold-load path.
  await page.waitForLoadState('domcontentloaded')

  // M5-B / ADR-0049 added a first-run WelcomeModal gated on
  // `settings.hasSeenWelcome`. Every E2E spec lands on a fresh
  // userData dir → the modal is visible on first paint; dismiss it
  // here so individual specs don't each have to.
  await dismissWelcomeIfShown(page)

  return {
    app,
    page,
    userDataDir,
    cleanup: async () => {
      try {
        await app.close()
      } catch {
        /* already closed - ignore */
      }
      await rm(userDataDir, { recursive: true, force: true })
    }
  }
}

async function dismissWelcomeIfShown(page: Page): Promise<void> {
  // 2 s window - the modal renders synchronously off useSettings,
  // so on a fresh userData it's there within the first paint. The
  // short timeout means the wait costs nothing on subsequent tests
  // that reuse a hot Electron process (none today, but cheap insurance).
  const got = page.getByRole('button', { name: /got it/i })
  try {
    await got.waitFor({ state: 'visible', timeout: 2_000 })
    await got.click()
  } catch {
    // Not shown - either modal already dismissed or we're starting in
    // a flow that doesn't render boards-home. Nothing to do.
  }
}
