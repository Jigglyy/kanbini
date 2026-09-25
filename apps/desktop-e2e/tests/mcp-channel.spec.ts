import { expect, test } from '@playwright/test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
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

/** POST a JSON-RPC call to the real channel and return the parsed body,
 *  failing the test with the channel's own error on a non-200. */
async function rpc<T = unknown>(
  d: McpJson,
  method: string,
  params: unknown
): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${d.port}/rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${d.token}`
    },
    body: JSON.stringify({ method, params })
  })
  const body = (await res.json()) as T & { error?: string }
  if (res.status !== 200) {
    throw new Error(`${method} -> HTTP ${res.status}: ${body.error ?? ''}`)
  }
  return body
}

interface ViewLite {
  board: { id: string }
  lists: Array<{ id: string; cards: Array<{ id: string; title: string }> }>
}

/** The seeded Welcome Board's id + first card. */
async function welcomeCard(d: McpJson) {
  const boards = await rpc<Array<{ id: string; name: string }>>(
    d,
    'boards.list',
    {}
  )
  const boardId = boards.find((b) => b.name === 'Welcome Board')!.id
  const view = await rpc<ViewLite>(d, 'board.getView', { boardId })
  const card = view.lists.flatMap((l) => l.cards)[0]!
  return { boardId, card }
}

test('attachments add + delete through the real channel touch real files', async () => {
  // The desktop channel is the one surface the MCP vitest suite can't
  // reach (it runs a fake). This drives the real one: files must land
  // under the real <userData>/attachments, and BOTH delete routes - the
  // dedicated method and a plain `mutate` arm, which used to drop the
  // row and strand the file - must remove them.
  const userDataDir = await mkdtemp(join(tmpdir(), 'kanbini-e2e-mcp-'))
  handle = await launchKanbini({ userDataDir })
  const d = await waitForDiscovery(userDataDir)
  const { card } = await welcomeCard(d)

  interface Added { id: string; relPath: string; filename: string; boardId: string }

  // Inline content via JSON-RPC.
  const inline = await rpc<Added>(d, 'attachment.add', {
    cardId: card.id,
    filename: 'from-ai.md',
    content: '# written by a tool'
  })
  const inlinePath = join(userDataDir, inline.relPath)
  expect(await readFile(inlinePath, 'utf8')).toBe('# written by a tool')

  // Path form via the REST alias.
  const src = join(userDataDir, 'outside-source.txt')
  await writeFile(src, 'copied in')
  const restRes = await fetch(`http://127.0.0.1:${d.port}/attachments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${d.token}`
    },
    body: JSON.stringify({ cardId: card.id, path: src })
  })
  expect(restRes.status).toBe(200)
  const copied = (await restRes.json()) as Added
  const copiedPath = join(userDataDir, copied.relPath)
  expect(await readFile(copiedPath, 'utf8')).toBe('copied in')

  // Both show on the card.
  const view = await rpc<{ attachments: Array<{ id: string }> }>(
    d,
    'card.get',
    { id: card.id }
  )
  expect(view.attachments.map((a) => a.id)).toEqual(
    expect.arrayContaining([inline.id, copied.id])
  )

  // Delete one via the dedicated method, one via plain `mutate`.
  await rpc(d, 'attachment.delete', { id: inline.id })
  await rpc(d, 'mutate', { type: 'attachment.delete', id: copied.id })
  expect(existsSync(inlinePath)).toBe(false)
  expect(existsSync(copiedPath)).toBe(false)
  // The source file outside userData is untouched.
  expect(await readFile(src, 'utf8')).toBe('copied in')
})

test('archiving a card through the channel hides it from the open board', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'kanbini-e2e-mcp-'))
  handle = await launchKanbini({ userDataDir })
  const { page } = handle
  const d = await waitForDiscovery(userDataDir)
  const { boardId, card } = await welcomeCard(d)

  // Watch it happen live in the UI, the way a user would while an AI
  // works.
  await page.getByText('Welcome Board', { exact: true }).click()
  const onBoard = page.locator(`[data-card-id="${card.id}"]`)
  await expect(onBoard).toBeVisible()

  await rpc(d, 'mutate', {
    type: 'card.update',
    id: card.id,
    patch: { archived: true }
  })
  await expect(onBoard).toHaveCount(0)

  // Findable again via the archived read's REST alias.
  const res = await fetch(
    `http://127.0.0.1:${d.port}/boards/${encodeURIComponent(boardId)}/archived`,
    { headers: { Authorization: `Bearer ${d.token}` } }
  )
  expect(res.status).toBe(200)
  const archived = (await res.json()) as { cards: Array<{ id: string }> }
  expect(archived.cards.map((c) => c.id)).toEqual([card.id])

  // Restoring brings it straight back into the open board.
  await rpc(d, 'mutate', {
    type: 'card.update',
    id: card.id,
    patch: { archived: false }
  })
  await expect(onBoard).toBeVisible()
})
