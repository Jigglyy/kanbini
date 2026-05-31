import { expect, test } from '@playwright/test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { launchKanbini, type E2EHandle } from './_launch.js'

// E2E for the M3 MCP control channel (ADR-0018). Verifies that
// booting the desktop app:
//   1. Writes `<userData>/mcp.json` with port + token + pid
//   2. Writes `<userData>/mcp-token` with the same token (0o600 on
//      POSIX; we just check existence + content match)
//   3. Listens on 127.0.0.1:<port> + accepts Authorization: Bearer
//      <token> + responds to the read methods the MCP server uses
//   4. Rejects requests with no token (401)
//
// This is the lowest-level "AI integration works" check - if the
// channel is wrong, no MCP client would ever connect.

let handle: E2EHandle

test.afterEach(async () => {
  await handle?.cleanup()
})

interface McpJson {
  port: number
  token: string
  pid: number
}

/** Poll for `<userData>/mcp.json` to appear after launch - main
 *  writes it inside app.whenReady, so it isn't guaranteed by the
 *  time `firstWindow` resolves. */
async function waitForDiscovery(
  userDataDir: string,
  timeoutMs = 5000
): Promise<McpJson> {
  const start = Date.now()
  const path = join(userDataDir, 'mcp.json')
  while (Date.now() - start < timeoutMs) {
    try {
      const raw = await readFile(path, 'utf8')
      return JSON.parse(raw) as McpJson
    } catch {
      await sleep(100)
    }
  }
  throw new Error(`mcp.json did not appear at ${path} within ${timeoutMs} ms`)
}

test('mcp.json + mcp-token are written + the bearer-auth channel responds', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'kanbini-e2e-mcp-'))
  handle = await launchKanbini({ userDataDir })

  // Wait for the discovery file then sanity-check its shape.
  const discovery = await waitForDiscovery(userDataDir)
  expect(typeof discovery.port).toBe('number')
  expect(discovery.port).toBeGreaterThan(0)
  expect(discovery.token.length).toBeGreaterThanOrEqual(64) // 32-byte hex
  expect(typeof discovery.pid).toBe('number')

  // mcp-token sits alongside mcp.json + holds the same token. The
  // MCP bundle reads from either path; mismatched contents would
  // cause silent 401s from any client.
  const token = (
    await readFile(join(userDataDir, 'mcp-token'), 'utf8')
  ).trim()
  expect(token).toBe(discovery.token)

  // boards.list against the real channel. The control channel uses
  // the same allow-list documented in ADR-0018 - boards.list is
  // method[0].
  const res = await fetch(`http://127.0.0.1:${discovery.port}/rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${discovery.token}`
    },
    body: JSON.stringify({ method: 'boards.list', params: {} })
  })
  expect(res.status).toBe(200)
  const boards = (await res.json()) as Array<{ name: string }>
  expect(Array.isArray(boards)).toBe(true)
  // Welcome Board is pre-seeded on first boot.
  expect(boards.some((b) => b.name === 'Welcome Board')).toBe(true)
})

test('control channel rejects unauthenticated requests with 401', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'kanbini-e2e-mcp-'))
  handle = await launchKanbini({ userDataDir })
  const discovery = await waitForDiscovery(userDataDir)

  // No Authorization header → 401.
  const noAuth = await fetch(`http://127.0.0.1:${discovery.port}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'boards.list', params: {} })
  })
  expect(noAuth.status).toBe(401)

  // Wrong token → 401 (constant-time compare).
  const badAuth = await fetch(`http://127.0.0.1:${discovery.port}/rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + 'x'.repeat(discovery.token.length)
    },
    body: JSON.stringify({ method: 'boards.list', params: {} })
  })
  expect(badAuth.status).toBe(401)
})

test('control channel rejects an unknown method with 400', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'kanbini-e2e-mcp-'))
  handle = await launchKanbini({ userDataDir })
  const discovery = await waitForDiscovery(userDataDir)

  const res = await fetch(`http://127.0.0.1:${discovery.port}/rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${discovery.token}`
    },
    body: JSON.stringify({ method: 'does.not.exist', params: {} })
  })
  expect(res.status).toBe(400)
  const body = (await res.json()) as { error?: string }
  expect(body.error).toMatch(/unknown method/i)
})
