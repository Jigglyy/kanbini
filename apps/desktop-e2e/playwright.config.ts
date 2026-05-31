import { defineConfig } from '@playwright/test'

// E2E tests for the Electron app (apps/desktop). Each test launches
// a fresh Electron process via Playwright's _electron API against
// a temp userData directory (`KANBINI_USERDATA_OVERRIDE` env, see
// apps/desktop/src/main/index.ts) so runs are isolated and don't
// touch the real user's data.
//
// Tests run HEADLESS by default - the launcher (tests/_launch.ts)
// sets `KANBINI_E2E_HEADLESS=1` so the Electron BrowserWindow stays
// hidden after first paint. Playwright drives the page over CDP, so
// hidden vs visible is invisible to the spec; the only difference is
// the windows don't pop up + steal focus on the dev's machine. Set
// `KANBINI_E2E_HEADED=1` when you want to actually watch a spec
// run (debugging a flake, recording a demo, etc.).
//
// Pretest hook (scripts/prepare.mjs) rebuilds better-sqlite3 for
// Electron's Node ABI + runs electron-vite build so the launcher
// has a working `out/main/index.js` to point at.

export default defineConfig({
  testDir: './tests',
  // Each spec launches its OWN Electron against an isolated temp
  // userData dir (+ an ephemeral MCP port), so specs are independent
  // and safe to run in parallel. Each worker drives a separate
  // offscreen Electron; 4 locally is a good speed/RAM trade, 2 on CI.
  // Lower this if a machine has fewer cores to spare.
  workers: process.env['CI'] ? 2 : 4,
  // Electron's launch + first-window paint + test interactions
  // comfortably fit in 60 s on a normal machine; bump if the CI is
  // slower.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // No retries - flakes should be fixed at the test level, not
  // papered over by re-runs. Surface them loudly.
  retries: 0,
  fullyParallel: true,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: {
    // Per-test artifacts on failure - Playwright records the page
    // history + the network so a flake is debuggable from the
    // trace alone.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  }
})
