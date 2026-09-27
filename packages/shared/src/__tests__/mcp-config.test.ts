import { describe, expect, it } from 'vitest'
import {
  buildMcpClientSnippet,
  buildMcpServerEntry,
  buildMcpServerPointer,
  MCP_BUNDLE_PLACEHOLDER,
  MCP_SERVER_POINTER_FILE
} from '../mcp-config'

// Regression cover for the "works on the maintainer's machine" class
// of MCP-config bug. A packaged Kanbini ships its own Node runtime
// inside Electron; the snippet must use it rather than assume the
// user installed Node.js separately.

const PACKAGED_EXE = String.raw`C:\Users\x\AppData\Local\Programs\Kanbini\Kanbini.exe`
const BUNDLE = String.raw`C:\Users\x\AppData\Local\Programs\Kanbini\resources\mcp\index.js`

describe('buildMcpClientSnippet', () => {
  it('spawns the app itself as a Node runtime when packaged', () => {
    const cfg = JSON.parse(
      buildMcpClientSnippet({
        isPackaged: true,
        execPath: PACKAGED_EXE,
        bundle: BUNDLE
      })
    )
    expect(cfg.mcpServers.kanbini.command).toBe(PACKAGED_EXE)
    expect(cfg.mcpServers.kanbini.args).toEqual([BUNDLE])
    // Without this, Electron boots a window instead of running the
    // script, and the client waits forever on a handshake that the
    // server never sends.
    expect(cfg.mcpServers.kanbini.env).toEqual({
      ELECTRON_RUN_AS_NODE: '1'
    })
  })

  it('never tells a packaged install to use bare `node`', () => {
    const cfg = JSON.parse(
      buildMcpClientSnippet({
        isPackaged: true,
        execPath: PACKAGED_EXE,
        bundle: BUNDLE
      })
    )
    expect(cfg.mcpServers.kanbini.command).not.toBe('node')
  })

  it('uses plain node in dev, with no env block', () => {
    // process.execPath in dev is the node_modules Electron dev binary
    // - a worse thing to paste into a long-lived client config than
    // the `node` a developer already has on PATH.
    const cfg = JSON.parse(
      buildMcpClientSnippet({
        isPackaged: false,
        execPath: String.raw`C:\repo\node_modules\electron\dist\electron.exe`,
        bundle: String.raw`C:\repo\apps\mcp\dist\index.js`
      })
    )
    expect(cfg.mcpServers.kanbini.command).toBe('node')
    expect(cfg.mcpServers.kanbini.env).toBeUndefined()
  })

  it('falls back to a visible placeholder when the bundle is missing', () => {
    const cfg = JSON.parse(
      buildMcpClientSnippet({
        isPackaged: false,
        execPath: 'node',
        bundle: null
      })
    )
    expect(cfg.mcpServers.kanbini.args).toEqual([MCP_BUNDLE_PLACEHOLDER])
  })

  it('emits formatted JSON a user can paste as-is', () => {
    const text = buildMcpClientSnippet({
      isPackaged: true,
      execPath: PACKAGED_EXE,
      bundle: BUNDLE
    })
    expect(text).toContain('\n  "mcpServers"')
    // Windows paths must survive JSON escaping intact.
    expect(JSON.parse(text).mcpServers.kanbini.args[0]).toBe(BUNDLE)
  })
})

describe('buildMcpServerEntry / buildMcpServerPointer', () => {
  it('is exactly the entry the Settings snippet shows', () => {
    for (const isPackaged of [true, false]) {
      const input = { isPackaged, execPath: PACKAGED_EXE, bundle: BUNDLE }
      const snippet = JSON.parse(buildMcpClientSnippet(input))
      expect(buildMcpServerEntry(input)).toEqual(snippet.mcpServers.kanbini)
    }
  })

  it('adds the writing app version and a timestamp to the pointer', () => {
    expect(
      buildMcpServerPointer({
        isPackaged: true,
        execPath: PACKAGED_EXE,
        bundle: BUNDLE,
        version: '1.2.3',
        now: 42
      })
    ).toEqual({
      command: PACKAGED_EXE,
      args: [BUNDLE],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      version: '1.2.3',
      writtenAt: 42
    })
  })

  it('names the pointer file the plugin launcher reads', () => {
    // plugins/kanbini/server/launch.mjs hardcodes this name (it has no
    // dependencies); the plugin test in @kanbini/mcp checks they match.
    expect(MCP_SERVER_POINTER_FILE).toBe('mcp-server.json')
  })
})
