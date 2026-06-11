import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_CODENAME } from '@kanbini/shared'
import { startFakeChannel, type FakeChannel } from './_fake-channel'

// Focused write-tool coverage that smoke-write.test.ts doesn't reach.
// Smoke covers the create → update → comment → checklist → delete
// chain on one card. This file covers the still-uncovered tools
// (board.create, set_card_labels, move_card), the zod validation
// edge cases, and the ADR-0045 offline error path for writes (which
// is distinct from the read fallback covered by headless.test.ts).

const here = dirname(fileURLToPath(import.meta.url))
const SERVER_PATH = resolve(here, '../../dist/index.js')

if (!existsSync(SERVER_PATH)) {
  throw new Error(
    `MCP bundle missing at ${SERVER_PATH}. Run \`pnpm --filter @kanbini/mcp run build\` first.`
  )
}

/** Pull tool-result JSON, throwing on isError so the test fails with
 *  the channel's error message instead of a generic shape mismatch. */
function unwrap<T = unknown>(res: unknown, label: string): T {
  const r = res as {
    content?: Array<{ text?: string } | undefined>
    isError?: boolean
  }
  const text = r.content?.[0]?.text ?? '(no text)'
  if (r.isError) throw new Error(`${label} failed: ${text}`)
  return JSON.parse(text) as T
}

/** As above but for the error-path tests - returns the error text
 *  instead of throwing on isError. */
function unwrapError(res: unknown): string {
  const r = res as {
    content?: Array<{ text?: string } | undefined>
    isError?: boolean
  }
  if (!r.isError) throw new Error('expected an error result')
  return r.content?.[0]?.text ?? '(no text)'
}

describe('MCP write tools - uncovered tools', () => {
  let channel: FakeChannel
  let client: Client

  beforeAll(async () => {
    channel = await startFakeChannel()
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_PATH],
      env: {
        ...process.env,
        KANBINI_USERDATA_OVERRIDE: channel.userDataDir
      }
    })
    client = new Client({
      name: 'kanbini-mcp-write-tools-test',
      version: '0.0.0'
    })
    await client.connect(transport)
  }, 30_000)

  afterAll(async () => {
    await client?.close().catch(() => {})
    await channel?.close()
  })

  it('kanbini_create_board mints a new empty board surfaced in list_boards', async () => {
    const before = unwrap<Array<{ id: string }>>(
      await client.callTool({ name: 'kanbini_list_boards', arguments: {} }),
      'list_boards (before)'
    )
    const created = unwrap<{ id: string; boardId: string }>(
      await client.callTool({
        name: 'kanbini_create_board',
        arguments: { name: 'MCP-made board', description: 'via test' }
      }),
      'create_board'
    )
    expect(created.id).toBeTruthy()
    expect(created.boardId).toBe(created.id)
    const after = unwrap<Array<{ id: string; name: string; description: string | null }>>(
      await client.callTool({ name: 'kanbini_list_boards', arguments: {} }),
      'list_boards (after)'
    )
    expect(after.length).toBe(before.length + 1)
    const fresh = after.find((b) => b.id === created.id)
    expect(fresh).toBeTruthy()
    expect(fresh!.name).toBe('MCP-made board')
    expect(fresh!.description).toBe('via test')
  })

  it('kanbini_create_list + create_card(priority) populate a fresh board end-to-end', async () => {
    // The full AI bootstrap path: create_board used to be a dead end
    // (no tool could add lists, so the new board stayed unusable).
    const board = unwrap<{ id: string }>(
      await client.callTool({
        name: 'kanbini_create_board',
        arguments: { name: 'Bootstrap board' }
      }),
      'create_board'
    )
    const list = unwrap<{ id: string; boardId: string }>(
      await client.callTool({
        name: 'kanbini_create_list',
        arguments: { boardId: board.id, name: 'Backlog' }
      }),
      'create_list'
    )
    expect(list.boardId).toBe(board.id)

    const card = unwrap<{ id: string }>(
      await client.callTool({
        name: 'kanbini_create_card',
        arguments: { listId: list.id, title: 'Urgent thing', priority: 'urgent' }
      }),
      'create_card (priority)'
    )
    const detail = unwrap<{ title: string; priority: string | null }>(
      await client.callTool({
        name: 'kanbini_get_card',
        arguments: { id: card.id }
      }),
      'get_card'
    )
    expect(detail.title).toBe('Urgent thing')
    expect(detail.priority).toBe('urgent')

    const view = unwrap<{
      lists: Array<{ id: string; name: string; cards: Array<{ id: string }> }>
    }>(
      await client.callTool({
        name: 'kanbini_get_board',
        arguments: { boardId: board.id }
      }),
      'get_board (bootstrap)'
    )
    expect(view.lists.map((l) => l.name)).toEqual(['Backlog'])
    expect(view.lists[0]!.cards.map((c) => c.id)).toEqual([card.id])
  })

  it('kanbini_set_card_labels replaces the full label set (additive)', async () => {
    const board = unwrap<{
      labels: Array<{ id: string; name: string }>
      lists: Array<{ cards: Array<{ id: string; labelIds: string[] }> }>
    }>(
      await client.callTool({ name: 'kanbini_get_board', arguments: {} }),
      'get_board'
    )
    expect(board.labels.length).toBeGreaterThanOrEqual(2)
    const card = board.lists[0]!.cards[0]!
    const allIds = board.labels.map((l) => l.id)
    unwrap(
      await client.callTool({
        name: 'kanbini_set_card_labels',
        arguments: { id: card.id, labelIds: allIds }
      }),
      'set_card_labels (all)'
    )
    const detail = unwrap<{ labelIds: string[] }>(
      await client.callTool({
        name: 'kanbini_get_card',
        arguments: { id: card.id }
      }),
      'get_card (after add)'
    )
    expect(detail.labelIds.sort()).toEqual([...allIds].sort())
  })

  it('kanbini_set_card_labels with an empty array removes every label', async () => {
    const board = unwrap<{
      lists: Array<{ cards: Array<{ id: string }> }>
    }>(
      await client.callTool({ name: 'kanbini_get_board', arguments: {} }),
      'get_board'
    )
    const card = board.lists[0]!.cards[0]!
    unwrap(
      await client.callTool({
        name: 'kanbini_set_card_labels',
        arguments: { id: card.id, labelIds: [] }
      }),
      'set_card_labels (empty)'
    )
    const detail = unwrap<{ labelIds: string[] }>(
      await client.callTool({
        name: 'kanbini_get_card',
        arguments: { id: card.id }
      }),
      'get_card (after clear)'
    )
    expect(detail.labelIds).toEqual([])
  })

  it('kanbini_move_card moves a card between lists (start of new list)', async () => {
    const board = unwrap<{
      lists: Array<{
        id: string
        name: string
        cards: Array<{ id: string; title: string }>
      }>
    }>(
      await client.callTool({ name: 'kanbini_get_board', arguments: {} }),
      'get_board'
    )
    const [from, to] = board.lists
    expect(from).toBeTruthy()
    expect(to).toBeTruthy()
    const movingCard = from!.cards[0]
    expect(movingCard).toBeTruthy()

    unwrap(
      await client.callTool({
        name: 'kanbini_move_card',
        arguments: {
          id: movingCard!.id,
          toListId: to!.id,
          beforeId: null,
          afterId: null
        }
      }),
      'move_card'
    )

    const after = unwrap<{
      lists: Array<{
        id: string
        cards: Array<{ id: string; title: string }>
      }>
    }>(
      await client.callTool({ name: 'kanbini_get_board', arguments: {} }),
      'get_board (after move)'
    )
    const fromAfter = after.lists.find((l) => l.id === from!.id)!
    const toAfter = after.lists.find((l) => l.id === to!.id)!
    expect(fromAfter.cards.find((c) => c.id === movingCard!.id)).toBeUndefined()
    expect(toAfter.cards.some((c) => c.id === movingCard!.id)).toBe(true)
  })

  it('kanbini_post_comment recovers line breaks from a body sent with literal "\\n" escapes', async () => {
    // Some MCP clients send the whole body with the escape sequences
    // written out literally (backslash + 'n' rather than a real
    // newline). Markdown then renders "\n" as text and the breaks
    // vanish. The server decodes a wholly-escaped body before storing.
    const board = unwrap<{
      lists: Array<{ cards: Array<{ id: string }> }>
    }>(
      await client.callTool({ name: 'kanbini_get_board', arguments: {} }),
      'get_board'
    )
    const card = board.lists[0]!.cards[0]!
    // In this source, '\\n' is a literal backslash + 'n' (two chars) -
    // exactly what arrives when a client double-escapes the JSON value.
    const escaped = 'Implemented.\\n\\n- one\\n- two'
    unwrap(
      await client.callTool({
        name: 'kanbini_post_comment',
        arguments: { cardId: card.id, body: escaped }
      }),
      'post_comment (escaped)'
    )
    const detail = unwrap<{
      comments: Array<{ body: string; author: string | null }>
    }>(
      await client.callTool({
        name: 'kanbini_get_card',
        arguments: { id: card.id }
      }),
      'get_card (after comment)'
    )
    const posted = detail.comments.find((c) => c.body.startsWith('Implemented.'))
    expect(posted).toBeTruthy()
    expect(posted!.author).toBe('ai')
    // Stored with real newlines, not the literal escape sequence.
    expect(posted!.body).toBe('Implemented.\n\n- one\n- two')
    expect(posted!.body).not.toContain('\\n')
  })

  it('kanbini_move_card defaults missing beforeId/afterId to null', async () => {
    const board = unwrap<{
      lists: Array<{
        id: string
        cards: Array<{ id: string }>
      }>
    }>(
      await client.callTool({ name: 'kanbini_get_board', arguments: {} }),
      'get_board'
    )
    const targetList = board.lists.find((l) => l.cards.length > 0)!
    const card = targetList.cards[0]!
    // No-arg move (no beforeId / afterId) - the renderer code path
    // that maps to "send card to the end of its list".
    const res = await client.callTool({
      name: 'kanbini_move_card',
      arguments: { id: card.id, toListId: targetList.id }
    })
    expect((res as { isError?: boolean }).isError).toBeFalsy()
  })
})

describe('MCP write tools - validation errors', () => {
  let channel: FakeChannel
  let client: Client

  beforeAll(async () => {
    channel = await startFakeChannel()
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_PATH],
      env: {
        ...process.env,
        KANBINI_USERDATA_OVERRIDE: channel.userDataDir
      }
    })
    client = new Client({
      name: 'kanbini-mcp-write-tools-validation',
      version: '0.0.0'
    })
    await client.connect(transport)
  }, 30_000)

  afterAll(async () => {
    await client?.close().catch(() => {})
    await channel?.close()
  })

  // The SDK runs each tool's inputSchema on the server side and
  // returns the zod-issues array wrapped in `{ isError: true, content:
  // [{ type:'text', text: <json> }] }` - it does NOT throw out of
  // `client.callTool`. The test asserts the isError + the zod path
  // for the field that failed so we'd catch a regression if a tool's
  // input schema were ever loosened by accident.

  /** Assert the call returned an isError result that mentions the
   *  given zod path segment. */
  function expectValidationError(res: unknown, pathSegment: string): void {
    const r = res as {
      isError?: boolean
      content?: Array<{ text?: string } | undefined>
    }
    expect(r.isError).toBe(true)
    expect(r.content?.[0]?.text ?? '').toContain(pathSegment)
  }

  it('rejects create_card with empty title (zod min(1))', async () => {
    const board = unwrap<{ lists: Array<{ id: string }> }>(
      await client.callTool({ name: 'kanbini_get_board', arguments: {} }),
      'get_board'
    )
    expectValidationError(
      await client.callTool({
        name: 'kanbini_create_card',
        arguments: { listId: board.lists[0]!.id, title: '' }
      }),
      'title'
    )
  })

  it('rejects create_board with empty name', async () => {
    expectValidationError(
      await client.callTool({
        name: 'kanbini_create_board',
        arguments: { name: '' }
      }),
      'name'
    )
  })

  it('rejects create_list with empty name', async () => {
    expectValidationError(
      await client.callTool({
        name: 'kanbini_create_list',
        arguments: { boardId: 'whatever', name: '' }
      }),
      'name'
    )
  })

  it('rejects create_card with an invalid priority enum', async () => {
    expectValidationError(
      await client.callTool({
        name: 'kanbini_create_card',
        arguments: { listId: 'whatever', title: 'x', priority: 'asap' }
      }),
      'priority'
    )
  })

  it('rejects post_comment with empty body', async () => {
    expectValidationError(
      await client.callTool({
        name: 'kanbini_post_comment',
        arguments: { cardId: 'whatever', body: '' }
      }),
      'body'
    )
  })

  it('rejects update_card with an invalid priority enum', async () => {
    expectValidationError(
      await client.callTool({
        name: 'kanbini_update_card',
        arguments: {
          id: 'whatever',
          patch: { priority: 'critical' }
        }
      }),
      'priority'
    )
  })

  it('rejects search_cards with limit > 100', async () => {
    expectValidationError(
      await client.callTool({
        name: 'kanbini_search_cards',
        arguments: { query: 'x', limit: 500 }
      }),
      'limit'
    )
  })
})

describe('MCP write tools - offline behaviour (ADR-0045)', () => {
  // No fake channel here - the MCP spawns against a userData dir
  // that has NO mcp.json + NO export, so writes must error with the
  // updated AppOfflineError message.
  let tmp: string
  let userDataDir: string
  let client: Client

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kanbini-mcp-write-offline-'))
    userDataDir = join(tmp, APP_CODENAME)
    await mkdir(userDataDir, { recursive: true })
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_PATH],
      env: {
        ...process.env,
        KANBINI_USERDATA_OVERRIDE: userDataDir
      }
    })
    client = new Client({
      name: 'kanbini-mcp-write-tools-offline',
      version: '0.0.0'
    })
    await client.connect(transport)
  }, 30_000)

  afterAll(async () => {
    await client?.close().catch(() => {})
    await rm(tmp, { recursive: true, force: true })
  })

  it('kanbini_create_board errors with the updated offline message', async () => {
    const text = unwrapError(
      await client.callTool({
        name: 'kanbini_create_board',
        arguments: { name: 'offline attempt' }
      })
    )
    expect(text).toMatch(/desktop app is not running/i)
    expect(text).toMatch(/writes need the app open/i)
  })

  it('kanbini_create_card errors with the updated offline message', async () => {
    const text = unwrapError(
      await client.callTool({
        name: 'kanbini_create_card',
        arguments: { listId: 'whatever', title: 'offline' }
      })
    )
    expect(text).toMatch(/desktop app is not running/i)
  })

  it('kanbini_post_comment errors with the updated offline message', async () => {
    const text = unwrapError(
      await client.callTool({
        name: 'kanbini_post_comment',
        arguments: { cardId: 'whatever', body: 'hello' }
      })
    )
    expect(text).toMatch(/desktop app is not running/i)
  })

  it('mentions that reads fall back to the export', async () => {
    const text = unwrapError(
      await client.callTool({
        name: 'kanbini_delete_card',
        arguments: { id: 'whatever' }
      })
    )
    expect(text).toMatch(/reads fall back/i)
  })
})
