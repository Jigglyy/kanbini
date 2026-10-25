import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { applyMutation, getBoardView } from '@kanbini/db'
import { localDayStart, type AgendaView } from '@kanbini/shared'
import { startFakeChannel, type FakeChannel } from './_fake-channel'

// MCP server integration smoke (read tools). Mirrors the manual
// `pnpm --filter @kanbini/mcp run smoke` script as a Vitest suite -
// every assertion drives the real MCP bundle as an MCP stdio client,
// so the SDK framing, the tool registry, the userData discovery, the
// bearer-auth HTTP hop, and the control-channel allow-list are all on
// the path. The desktop app is replaced with a fake HTTP control
// channel in-process (see `_fake-channel.ts`) so the suite is
// self-contained - no Electron, no GUI, runs in CI.

const here = dirname(fileURLToPath(import.meta.url))
// src/__tests__/smoke.test.ts → dist/index.js
const SERVER_PATH = resolve(here, '../../dist/index.js')

if (!existsSync(SERVER_PATH)) {
  // The `pretest` hook builds the MCP bundle so this should always be
  // present - but if a developer ran vitest directly, fail loud.
  throw new Error(
    `MCP bundle missing at ${SERVER_PATH}. Run \`pnpm --filter @kanbini/mcp run build\` first.`
  )
}

let channel: FakeChannel
let client: Client

/** Pull the JSON text out of an MCP tool result, throwing if the tool
 *  responded with isError. The SDK's response type is richer than what
 *  we care about - typed as `unknown` here, narrowed inline. */
function unwrap<T = unknown>(res: unknown, label: string): T {
  const r = res as {
    content?: Array<{ text?: string } | undefined>
    isError?: boolean
  }
  const text = r.content?.[0]?.text ?? '(no text)'
  if (r.isError) throw new Error(`${label} failed: ${text}`)
  return JSON.parse(text) as T
}

beforeAll(async () => {
  channel = await startFakeChannel()
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    // Spawn the MCP child with our userData override so it discovers
    // the fake control channel instead of the running desktop's.
    env: {
      ...process.env,
      KANBINI_USERDATA_OVERRIDE: channel.userDataDir
    }
  })
  client = new Client({
    name: 'kanbini-mcp-smoke-test',
    version: '0.0.0'
  })
  await client.connect(transport)
}, 30_000)

afterAll(async () => {
  await client?.close().catch(() => {})
  await channel?.close()
})

describe('MCP read tools', () => {
  it('registers the expected read tool set', async () => {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    // Sample for stability - adding new tools shouldn't break this.
    expect(names).toEqual(expect.arrayContaining([
      'kanbini_list_boards',
      'kanbini_get_board',
      'kanbini_get_card',
      'kanbini_search_cards',
      'kanbini_get_agenda'
    ]))
  })

  it('kanbini_list_boards round-trips the seeded sample', async () => {
    const summaries = unwrap<Array<{ id: string; name: string }>>(
      await client.callTool({
        name: 'kanbini_list_boards',
        arguments: {}
      }),
      'list_boards'
    )
    expect(summaries.length).toBeGreaterThan(0)
    expect(summaries.some((b) => typeof b.name === 'string')).toBe(true)
  })

  it('kanbini_get_board returns the seeded board with lists + cards', async () => {
    const view = unwrap<{
      board: { name: string }
      lists: Array<{ name: string; cards: Array<{ id: string; title: string }> }>
    }>(
      await client.callTool({ name: 'kanbini_get_board', arguments: {} }),
      'get_board'
    )
    expect(view).not.toBeNull()
    expect(view.lists.length).toBeGreaterThan(0)
    // Sample seed includes a "To Do" list with at least one card.
    const firstList = view.lists[0]!
    expect(firstList.cards.length).toBeGreaterThan(0)
  })

  it('kanbini_get_card returns the card + its activity rows', async () => {
    const board = unwrap<{
      lists: Array<{ cards: Array<{ id: string }> }>
    }>(
      await client.callTool({ name: 'kanbini_get_board', arguments: {} }),
      'get_board'
    )
    const firstCard = board.lists[0]?.cards[0]
    expect(firstCard).toBeTruthy()
    const detail = unwrap<{
      id: string
      title: string
      activities: Array<{ type: string }>
    }>(
      await client.callTool({
        name: 'kanbini_get_card',
        arguments: { id: firstCard!.id }
      }),
      'get_card'
    )
    expect(detail.id).toBe(firstCard!.id)
    // The seed inserts cards via direct drizzle writes (no
    // applyMutation → no logActivity) so seeded cards may have zero
    // activities. The shape assertion is what matters here - the
    // write-tools test covers the activity-row generation path.
    expect(Array.isArray(detail.activities)).toBe(true)
  })

  it('kanbini_search_cards finds cards by substring', async () => {
    // The seed includes a card titled "Drag a card to another list".
    const hits = unwrap<Array<{ title: string; matchKind: string }>>(
      await client.callTool({
        name: 'kanbini_search_cards',
        arguments: { query: 'drag' }
      }),
      'search_cards'
    )
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.title.toLowerCase()).toContain('drag')
  })

  it('kanbini_get_card and kanbini_search_cards take a #number', async () => {
    const board = unwrap<{
      board: { id: string }
      lists: Array<{ cards: Array<{ id: string; number: number }> }>
    }>(
      await client.callTool({ name: 'kanbini_get_board', arguments: {} }),
      'get_board'
    )
    const card = board.lists[0]!.cards[0]!
    expect(card.number).toBeGreaterThan(0)
    const detail = unwrap<{ id: string; number: number }>(
      await client.callTool({
        name: 'kanbini_get_card',
        arguments: { id: `#${card.number}`, boardId: board.board.id }
      }),
      'get_card'
    )
    expect(detail).toMatchObject({ id: card.id, number: card.number })
    // Numbers are per board: without the board it's an error that says so.
    const bare = await client.callTool({
      name: 'kanbini_get_card',
      arguments: { id: `#${card.number}` }
    })
    expect(bare.isError).toBe(true)
    expect(JSON.stringify(bare.content)).toMatch(/per board/)
    const hits = unwrap<Array<{ cardId: string; number: number; matchKind: string }>>(
      await client.callTool({
        name: 'kanbini_search_cards',
        arguments: { query: `#${card.number}` }
      }),
      'search_cards'
    )
    expect(hits[0]).toMatchObject({ cardId: card.id, number: card.number, matchKind: 'number' })
  })

  it('kanbini_get_agenda buckets cards across the whole DB', async () => {
    // Plant one overdue card and one completed card on the seeded
    // board, straight through @kanbini/db (the completion writes the
    // activity row the agenda reads its completedAt from).
    const board = getBoardView(channel.db)!
    const [first, second] = board.lists.flatMap((l) => l.cards)
    const threeDaysAgo = localDayStart(Date.now(), -3)
    applyMutation(channel.db, {
      type: 'card.update',
      id: first!.id,
      patch: { dueAt: threeDaysAgo, completed: false }
    })
    applyMutation(channel.db, {
      type: 'card.update',
      id: second!.id,
      patch: { completed: true }
    })

    const agenda = unwrap<AgendaView>(
      await client.callTool({
        name: 'kanbini_get_agenda',
        arguments: { upcomingDays: 3, limit: 10 }
      }),
      'get_agenda'
    )
    expect(agenda.upcomingDays).toBe(3)
    expect(agenda.completedDays).toBe(7)
    expect(agenda.overdue.find((c) => c.cardId === first!.id)).toMatchObject({
      boardId: board.board.id,
      boardName: board.board.name,
      dueAt: threeDaysAgo
    })
    expect(agenda.completed.map((c) => c.cardId)).toContain(second!.id)
  })

  it('kanbini_get_agenda rejects an out-of-range window', async () => {
    const res = (await client.callTool({
      name: 'kanbini_get_agenda',
      arguments: { upcomingDays: 0 }
    })) as { isError?: boolean }
    expect(res.isError).toBe(true)
  })

  it('returns an MCP tool error (not a transport crash) for a missing card', async () => {
    const res = (await client.callTool({
      name: 'kanbini_get_card',
      arguments: { id: 'does-not-exist' }
    })) as { content?: Array<{ text?: string }>; isError?: boolean }
    // The fake channel returns `null` for missing cards (real DB path
    // does too). MCP surfaces this as a tool result, not an error -
    // the test confirms the round-trip + null serialisation work.
    expect(res.isError).toBeFalsy()
    const text = res.content?.[0]?.text ?? '(no text)'
    expect(JSON.parse(text)).toBeNull()
  })
})
