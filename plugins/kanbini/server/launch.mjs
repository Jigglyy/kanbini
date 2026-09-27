// Kanbini plugin launcher: starts the MCP server that ships inside the
// user's installed Kanbini app.
//
// The plugin deliberately carries no copy of the server. Kanbini writes
// `<userData>/mcp-server.json` on every launch with the exact command
// that runs ITS bundled server (the same entry Settings -> AI
// integration shows). Reading it here means:
//   - the server always matches the installed app's version, so the
//     tools line up with what the app's control channel understands;
//   - no token to paste: the server finds the app's port and token in
//     the same userData folder;
//   - no path to configure, wherever the app was installed.
//
// Zero dependencies on purpose (plain Node built-ins) so the plugin
// needs no install step. The pointer file name and the userData rules
// mirror `MCP_SERVER_POINTER_FILE` (@kanbini/shared/mcp-config) and
// `userDataDir()` (apps/mcp/src/index.ts); the plugin test in
// @kanbini/mcp pins both.

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const APP_NAME = 'Kanbini'
const POINTER_FILE = 'mcp-server.json'

/** Electron's `app.getPath('userData')` for the Kanbini app. */
function userDataDir() {
  const override = process.env.KANBINI_USERDATA_OVERRIDE
  if (override) return override
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    return join(appData, APP_NAME)
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', APP_NAME)
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return join(xdg, APP_NAME)
}

/** Explain on stderr (Claude Code shows it in /mcp) and exit. Nothing
 *  may go to stdout: that's the MCP channel. */
function fail(message) {
  process.stderr.write(`[kanbini plugin] ${message}\n`)
  process.exit(1)
}

function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

function isStringRecord(v) {
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.values(v).every((x) => typeof x === 'string')
  )
}

const pointerPath = join(userDataDir(), POINTER_FILE)

let raw
try {
  raw = await readFile(pointerPath, 'utf8')
} catch (e) {
  if (e && e.code === 'ENOENT') {
    fail(
      `Kanbini hasn't registered its MCP server on this computer yet ` +
        `(${pointerPath} is missing). Install Kanbini and open it once, ` +
        `then reconnect with /mcp.`
    )
  }
  fail(`Couldn't read ${pointerPath}: ${e instanceof Error ? e.message : e}`)
}

let entry
try {
  entry = JSON.parse(raw)
} catch {
  fail(`${pointerPath} isn't valid JSON. Open Kanbini once to rewrite it.`)
}
if (
  !entry ||
  typeof entry.command !== 'string' ||
  entry.command.length === 0 ||
  !isStringArray(entry.args) ||
  (entry.env !== undefined && !isStringRecord(entry.env))
) {
  fail(`${pointerPath} doesn't describe a server. Open Kanbini once to rewrite it.`)
}

// stdio is inherited, so the MCP messages flow straight between the
// client and the server; this process only waits.
const child = spawn(entry.command, entry.args, {
  stdio: 'inherit',
  env: { ...process.env, ...(entry.env ?? {}) },
  windowsHide: true
})

child.on('error', (e) => {
  fail(
    `Couldn't start Kanbini's MCP server with ${entry.command}: ${e.message}. ` +
      `If Kanbini was moved, updated, or uninstalled, open it once so it ` +
      `registers again, then reconnect with /mcp.`
  )
})

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0))
})

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    child.kill(sig)
  })
}
