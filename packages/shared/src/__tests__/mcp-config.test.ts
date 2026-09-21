import { describe, expect, it } from 'vitest'
import {
  buildMcpClientSnippet,
  MCP_BUNDLE_PLACEHOLDER
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
