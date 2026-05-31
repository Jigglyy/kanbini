// Minimal Electron entry: tries to load the better-sqlite3 native
// binding under the Electron runtime and exits 0/1. Used by
// scripts/ensure-electron-abi.mjs as a fast pre-check before a real
// `pnpm dev` so we know whether the binary's ABI matches Electron's.
//
// CommonJS on purpose - Electron's main process accepts CJS without a
// loader hook, and this script never depends on the rest of the app's
// TS build output.

const { app } = require('electron')

app.whenReady().then(() => {
  try {
    // better-sqlite3's `require()` is lazy - the .node binary is
    // only dlopen()'d when you construct a Database. So testing
    // require() alone passes even with a mismatched ABI binary.
    // Instantiate once to actually exercise the binding.
    const Database = require('better-sqlite3')
    const db = new Database(':memory:')
    db.close()
    app.exit(0)
  } catch (err) {
    process.stderr.write((err && err.message) || String(err))
    process.stderr.write('\n')
    app.exit(1)
  }
})
