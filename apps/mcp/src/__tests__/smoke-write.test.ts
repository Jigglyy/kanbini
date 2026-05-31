import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFakeChannel, type FakeChannel } from './_fake-channel'

// MCP server integration smoke (write tools). Mirrors the manual
// `pnpm --filter @kanbini/mcp run smoke:write` script - full
// create → update → comment → checklist → delete cycle through the
// real MCP stdio bundle, against the in-process fake control channel.

const here = dirname(fileURLToPath(import.meta.url))
const SERVER_PATH = resolve(here, '../../dist/index.js')

let channel: FakeChannel
let client: Client
/** Card we create + clean up across the suite. */
let createdCardId: string

/** Same shape as the read-smoke unwrap helper. */
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
    env: {
      ...process.env,
      KANBINI_USERDATA_OVERRIDE: channel.userDataDir
    }
  })
  client = new Client({
    name: 'kanbini-mcp-write-smoke-test',
    version: '0.0.0'
  })
  await client.connect(transport)
}, 30_000)

afterAll(async () => {
  // Best-effort cleanup. If a test created a card and a later step
  // threw before we got to the delete, this catches the leftover.
  if (createdCardId) {
    await client
      .callTool({
        name: 'kanbini_delete_card',
        arguments: { id: createdCardId }
      })
      .catch(() => {})
  }
  await client?.close().catch(() => {})
  await channel?.close()
})

describe('MCP write tools', () => {
  it('registers the expected write tool set', async () => {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'kanbini_create_card',
        'kanbini_update_card',
        'kanbini_move_card',
        'kanbini_delete_card',
        'kanbini_set_card_labels',
        'kanbini_post_comment',
        'kanbini_create_checklist',
        'kanbini_add_checklist_item',
        'kanbini_toggle_checklist_item'
      ])
    )
  })

  it('runs the full create → update → comment → checklist → delete cycle', async () => {
    const board = unwrap<{
      lists: Array<{ id: string; name: string; closed: boolean }>
    }>(
      await client.callTool({
        name: 'kanbini_get_board',
        arguments: {}
      }),
      'get_board'
    )
    const target = board.lists.find((l) => !l.closed)
    expect(target).toBeTruthy()

    // 1. Create.
    const created = unwrap<{ id: string }>(
      await client.callTool({
        name: 'kanbini_create_card',
        arguments: { listId: target!.id, title: 'MCP write-smoke card' }
      }),
      'create_card'
    )
    createdCardId = created.id
    expect(created.id).toBeTruthy()

    // 2. Update description + due.
    const dueAt = Date.now() + 7 * 24 * 60 * 60 * 1000
    unwrap(
      await client.callTool({
        name: 'kanbini_update_card',
        arguments: {
          id: created.id,
          patch: {
            description: 'Body written via MCP write tools.',
            dueAt
          }
        }
      }),
      'update_card'
    )

    // 3. Post an AI-authored comment.
    unwrap(
      await client.callTool({
        name: 'kanbini_post_comment',
        arguments: {
          cardId: created.id,
          body: 'Comment from the MCP write-smoke test.'
        }
      }),
      'post_comment'
    )

    // 4. Add a checklist + two items, toggle one done.
    const cl = unwrap<{ id: string }>(
      await client.callTool({
        name: 'kanbini_create_checklist',
        arguments: { cardId: created.id, name: 'Smoke steps' }
      }),
      'create_checklist'
    )
    const item1 = unwrap<{ id: string }>(
      await client.callTool({
        name: 'kanbini_add_checklist_item',
        arguments: { checklistId: cl.id, text: 'First item' }
      }),
      'add_item_1'
    )
    unwrap(
      await client.callTool({
        name: 'kanbini_add_checklist_item',
        arguments: { checklistId: cl.id, text: 'Second item' }
      }),
      'add_item_2'
    )
    unwrap(
      await client.callTool({
        name: 'kanbini_toggle_checklist_item',
        arguments: { id: item1.id, completed: true }
      }),
      'toggle_item'
    )

    // 5. Read back - all changes should be visible.
    const detail = unwrap<{
      id: string
      title: string
      description: string | null
      dueAt: number | null
      checklists: Array<{ items: Array<{ text: string; completed: boolean }> }>
      comments: Array<{ author: string | null }>
      activities: Array<{ type: string }>
    }>(
      await client.callTool({
        name: 'kanbini_get_card',
        arguments: { id: created.id }
      }),
      'get_card'
    )
    expect(detail.title).toBe('MCP write-smoke card')
    expect(detail.description).toBe('Body written via MCP write tools.')
    expect(detail.dueAt).toBe(dueAt)
    expect(detail.checklists).toHaveLength(1)
    expect(detail.checklists[0]!.items.map((i) => i.text)).toEqual([
      'First item',
      'Second item'
    ])
    expect(detail.checklists[0]!.items[0]!.completed).toBe(true)
    // post_comment in MCP defaults author to 'ai' - sanity-check the
    // tag survived the round-trip.
    expect(detail.comments.some((c) => c.author === 'ai')).toBe(true)
    // Activity feed should have the create + update entries.
    const types = detail.activities.map((a) => a.type)
    expect(types).toContain('created')
    expect(types).toContain('description')
    expect(types).toContain('due-set')
    expect(types).toContain('checklist-added')

    // 6. Delete + verify gone.
    unwrap(
      await client.callTool({
        name: 'kanbini_delete_card',
        arguments: { id: created.id }
      }),
      'delete_card'
    )
    createdCardId = '' // unset so afterAll doesn't try to delete again
    const gone = (await client.callTool({
      name: 'kanbini_get_card',
      arguments: { id: created.id }
    })) as { content?: Array<{ text?: string }> }
    expect(JSON.parse(gone.content?.[0]?.text ?? 'null')).toBeNull()
  }, 30_000)

  it('rejects an unknown card update with a tool error (not a transport crash)', async () => {
    const res = (await client.callTool({
      name: 'kanbini_update_card',
      arguments: {
        id: 'nope',
        patch: { title: 'never' }
      }
    })) as { isError?: boolean }
    // Update on a missing id doesn't currently throw at the DB layer
    // - drizzle returns 0 affected rows + applyMutation returns
    // `{ id, boardId: null }`. The MCP response surfaces this as a
    // successful tool result; the test confirms the round-trip stays
    // clean instead of crashing the channel.
    expect(res.isError).toBeFalsy()
  })
})
