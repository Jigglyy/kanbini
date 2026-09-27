import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyMutation, getBoardView } from '@kanbini/db'
import type { CardView } from '@kanbini/shared'
import { startFakeChannel, type FakeChannel } from './_fake-channel'

// kanbini_add_blocker / kanbini_remove_blocker through the real bundle
// and the fake control channel, plus the link data kanbini_get_card
// returns.

const here = dirname(fileURLToPath(import.meta.url))
const SERVER_PATH = resolve(here, '../../dist/index.js')
if (!existsSync(SERVER_PATH)) {
  throw new Error(
    `MCP bundle missing at ${SERVER_PATH}. Run \`pnpm --filter @kanbini/mcp run build\` first.`
  )
}

let channel: FakeChannel
let client: Client
let a: string
let b: string

type ToolResult = { content: Array<{ text: string }>; isError?: boolean }

const call = async (name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as ToolResult

async function getCard(id: string): Promise<CardView> {
  const res = await call('kanbini_get_card', { id })
  return JSON.parse(res.content[0]!.text) as CardView
}

beforeAll(async () => {
  channel = await startFakeChannel()
  const board = getBoardView(channel.db)!
  const listId = board.lists[0]!.id
  a = applyMutation(channel.db, { type: 'card.create', listId, title: 'Waiter' }).id
  b = applyMutation(channel.db, { type: 'card.create', listId, title: 'Blocker' }).id
  client = new Client({ name: 'kanbini-blockers-test', version: '0.0.0' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_PATH],
      env: { ...process.env, KANBINI_USERDATA_OVERRIDE: channel.userDataDir }
    })
  )
}, 30_000)

afterAll(async () => {
  await client?.close().catch(() => {})
  await channel?.close()
})

describe('blocker tools', () => {
  it('links two cards and kanbini_get_card shows both ends', async () => {
    const res = await call('kanbini_add_blocker', { cardId: a, blockerId: b })
    expect(res.isError).toBeFalsy()
    expect((await getCard(a)).blockedBy).toMatchObject([
      { cardId: b, title: 'Blocker', completed: false, archived: false }
    ])
    expect((await getCard(b)).blocking.map((r) => r.cardId)).toEqual([a])
  })

  it('refuses a loop with a readable error', async () => {
    const res = await call('kanbini_add_blocker', { cardId: b, blockerId: a })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toMatch(/loop/)
  })

  it('refuses a self-link', async () => {
    const res = await call('kanbini_add_blocker', { cardId: a, blockerId: a })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toMatch(/itself/)
  })

  it('unlinks, and a second unlink is a harmless no-op', async () => {
    expect((await call('kanbini_remove_blocker', { cardId: a, blockerId: b })).isError).toBeFalsy()
    expect((await getCard(a)).blockedBy).toEqual([])
    expect((await call('kanbini_remove_blocker', { cardId: a, blockerId: b })).isError).toBeFalsy()
  })
})
