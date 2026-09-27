import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchKanbini, type E2EHandle } from './_launch.js'
import { mutate, waitForDiscovery } from './_channel.js'

// E2E for the Claude Code plugin's path into the REAL app. On launch,
// main writes `<userData>/mcp-server.json` (how to start its own MCP
// server); the plugin's launcher (plugins/kanbini/server/launch.mjs)
// reads it and starts that server, which then finds the app's control
// channel through mcp.json. Here the launcher is spawned exactly the way
// Claude Code would (`node launch.mjs`, stdio), pointed at this test's
// userData, and a raw MCP session reads a board the app is showing.

const here = dirname(fileURLToPath(import.meta.url))
const LAUNCHER = resolve(here, '../../../plugins/kanbini/server/launch.mjs')

let handle: E2EHandle

test.beforeEach(async () => {
  handle = await launchKanbini()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

/** Wait for main's fire-and-forget pointer write. */
async function readPointer(userDataDir: string): Promise<{
  command: string
  args: string[]
  version: string
}> {
  const path = join(userDataDir, 'mcp-server.json')
  const start = Date.now()
  for (;;) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch (e) {
      if (Date.now() - start > 5000) throw e
      await new Promise((r) => setTimeout(r, 100))
    }
  }
}

test('the app registers its MCP server and the plugin launcher reaches it', async () => {
  const { userDataDir } = handle
  const pointer = await readPointer(userDataDir)
  // An unpackaged (dev / e2e) build runs the repo bundle on plain node.
  expect(pointer.command).toBe('node')
  expect(pointer.args[0]).toMatch(/apps[\\/]mcp[\\/]dist[\\/]index\.js$/)
  expect(pointer.version).toMatch(/^\d+\.\d+\.\d+/)

  // Something only the live app knows, to prove the answer isn't the
  // headless export.
  const d = await waitForDiscovery(userDataDir)
  const boardId = await mutate(d, { type: 'board.create', name: 'Made just now' })

  const child = spawn(process.execPath, [LAUNCHER], {
    env: { ...process.env, KANBINI_USERDATA_OVERRIDE: userDataDir },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (b: Buffer) => (stderr += b.toString()))
  const exited = new Promise<number | null>((r) => child.on('exit', r))

  let buf = ''
  const responses = new Map<number, { result?: unknown; error?: unknown }>()
  child.stdout.on('data', (b: Buffer) => {
    buf += b.toString()
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown }
      if (typeof msg.id === 'number') responses.set(msg.id, msg)
    }
  })
  const request = async (id: number, method: string, params: object) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    await expect.poll(() => responses.has(id), { timeout: 10_000 }).toBe(true)
    return responses.get(id)!
  }

  const init = await request(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'e2e-plugin', version: '0' }
  })
  expect(init.error).toBeUndefined()
  child.stdin.write(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'
  )

  const res = (await request(2, 'tools/call', {
    name: 'kanbini_list_boards',
    arguments: {}
  })) as { result: { content: Array<{ text: string }>; isError?: boolean } }
  expect(res.result.isError).toBeFalsy()
  const text = res.result.content[0]!.text
  expect(text.startsWith('[NOTE]')).toBe(false)
  const boards = JSON.parse(text) as Array<{ id: string; name: string }>
  expect(boards.find((b) => b.id === boardId)?.name).toBe('Made just now')

  // Hanging up ends the whole chain.
  child.stdin.end()
  expect(await exited).toBe(0)
  expect(stderr).toBe('')
})
