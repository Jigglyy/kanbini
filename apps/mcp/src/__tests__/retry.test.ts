import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFakeChannel, type FakeChannel } from './_fake-channel'

// Regression suite for the keep-alive race that showed up as a random
// "tool use error" right after a Kanbini MCP call. Node's global fetch
// pools keep-alive sockets; the control-channel server can close an idle
// one a beat before the client reuses it, so the next request lands on a
// dead socket (ECONNRESET). The MCP server used to misread that as "app
// offline" and surface a tool error. rpc() now retries once on a
// connection-level failure before giving up. The fake channel's
// `failNextRequests(n)` drops the next n requests (socket destroyed, no
// response) so we can drive that path deterministically through the real
// bundle - one drop must be transparently recovered; two in a row
// (exhausting the single retry) must still surface a clean offline error.

const here = dirname(fileURLToPath(import.meta.url))
const SERVER_PATH = resolve(here, '../../dist/index.js')

if (!existsSync(SERVER_PATH)) {
  throw new Error(
    `MCP bundle missing at ${SERVER_PATH}. Run \`pnpm --filter @kanbini/mcp run build\` first.`
  )
}

function unwrap<T = unknown>(res: unknown, label: string): T {
  const r = res as {
    content?: Array<{ text?: string } | undefined>
    isError?: boolean
  }
  const text = r.content?.[0]?.text ?? '(no text)'
  if (r.isError) throw new Error(`${label} failed: ${text}`)
  return JSON.parse(text) as T
}

function isError(res: unknown): boolean {
  return (res as { isError?: boolean }).isError === true
}
function errorText(res: unknown): string {
  return (res as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? ''
}

describe('MCP rpc retry - survives a stale keep-alive socket', () => {
  let channel: FakeChannel
  let client: Client

  beforeAll(async () => {
    channel = await startFakeChannel()
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_PATH],
      env: { ...process.env, KANBINI_USERDATA_OVERRIDE: channel.userDataDir }
    })
    client = new Client({ name: 'kanbini-mcp-retry-test', version: '0.0.0' })
    await client.connect(transport)
  }, 30_000)

  afterAll(async () => {
    await client?.close().catch(() => {})
    await channel?.close()
  })

  it('read tools recover from a dropped first request (one retry)', async () => {
    // Each read drops its first request; a successful unwrap proves the
    // retry reconnected AND that the result is live app data (a stale
    // "[NOTE] app is closed" export prefix would break JSON.parse).
    channel.failNextRequests(1)
    const board = unwrap<{ lists: Array<{ cards: Array<{ id: string }> }> }>(
      await client.callTool({ name: 'kanbini_get_board', arguments: {} }),
      'get_board after drop'
    )
    expect(Array.isArray(board.lists)).toBe(true)

    channel.failNextRequests(1)
    const boards = unwrap<Array<{ id: string }>>(
      await client.callTool({ name: 'kanbini_list_boards', arguments: {} }),
      'list_boards after drop'
    )
    expect(boards.length).toBeGreaterThan(0)

    const card = board.lists.find((l) => l.cards.length > 0)?.cards[0]
    expect(card).toBeTruthy()
    channel.failNextRequests(1)
    const detail = unwrap<{ id: string }>(
      await client.callTool({
        name: 'kanbini_get_card',
        arguments: { id: card!.id }
      }),
      'get_card after drop'
    )
    expect(detail.id).toBe(card!.id)

    channel.failNextRequests(1)
    const hits = unwrap<Array<unknown>>(
      await client.callTool({
        name: 'kanbini_search_cards',
        arguments: { query: 'a' }
      }),
      'search_cards after drop'
    )
    expect(Array.isArray(hits)).toBe(true)
  })

  it('a write tool recovers from a dropped first request', async () => {
    const board = unwrap<{ lists: Array<{ id: string }> }>(
      await client.callTool({ name: 'kanbini_get_board', arguments: {} }),
      'get_board'
    )
    channel.failNextRequests(1)
    const created = unwrap<{ id: string }>(
      await client.callTool({
        name: 'kanbini_create_card',
        arguments: { listId: board.lists[0]!.id, title: 'survives a reset' }
      }),
      'create_card after drop'
    )
    expect(created.id).toBeTruthy()
  })

  it('gives up with an offline error when BOTH attempts are dropped', async () => {
    // Two drops exhaust the single retry - we must not loop forever, and
    // the failure surfaces as a clean error (this userData has no export
    // to fall back to), not a hang.
    channel.failNextRequests(2)
    const res = await client.callTool({
      name: 'kanbini_get_board',
      arguments: {}
    })
    expect(isError(res)).toBe(true)
    expect(errorText(res)).toMatch(/not running|no on-disk export/i)
  })

  it('a deterministic channel error (unknown method) is NOT masked as offline', async () => {
    // 4xx/5xx from the channel are deterministic - surface them as-is,
    // never retry them or relabel them "app offline". Driven via a write
    // arm the channel rejects: post_comment with an empty body fails the
    // SDK schema before rpc, so instead we send a valid call against a
    // missing card id, which the channel answers with an application
    // error - and it must come back as that error, not "offline".
    const res = await client.callTool({
      name: 'kanbini_post_comment',
      arguments: { cardId: 'does-not-exist', body: 'hi' }
    })
    expect(isError(res)).toBe(true)
    expect(errorText(res)).not.toMatch(/not running/i)
  })
})
