import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyMutation, getBoardView } from '@kanbini/db'
import type { CardView } from '@kanbini/shared'
import { startFakeChannel, type FakeChannel } from './_fake-channel'

// Repeating cards over MCP: kanbini_update_card sets the rule, and an
// AI completing the card spawns the next one (the channel's recorded
// path), exactly as a click in the app would.

const here = dirname(fileURLToPath(import.meta.url))
const SERVER_PATH = resolve(here, '../../dist/index.js')
if (!existsSync(SERVER_PATH)) {
  throw new Error(
    `MCP bundle missing at ${SERVER_PATH}. Run \`pnpm --filter @kanbini/mcp run build\` first.`
  )
}

let channel: FakeChannel
let client: Client
let listId: string
let cardId: string

type ToolResult = { content: Array<{ text: string }>; isError?: boolean }
const call = async (name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as ToolResult

beforeAll(async () => {
  channel = await startFakeChannel()
  listId = getBoardView(channel.db)!.lists[0]!.id
  cardId = applyMutation(channel.db, { type: 'card.create', listId, title: 'Pay rent' }).id
  client = new Client({ name: 'kanbini-repeat-test', version: '0.0.0' })
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

describe('repeat over MCP', () => {
  it('sets a rule with kanbini_update_card', async () => {
    const res = await call('kanbini_update_card', {
      id: cardId,
      patch: { repeat: { unit: 'month', every: 1 } }
    })
    expect(res.isError).toBeFalsy()
    const card = JSON.parse(
      (await call('kanbini_get_card', { id: cardId })).content[0]!.text
    ) as CardView
    expect(card.repeat).toEqual({ unit: 'month', every: 1 })
  })

  it('rejects a bad rule at the tool boundary', async () => {
    const res = await call('kanbini_update_card', {
      id: cardId,
      patch: { repeat: { unit: 'fortnight', every: 1 } }
    })
    expect(res.isError).toBe(true)
  })

  it('completing it adds the next one', async () => {
    await call('kanbini_update_card', { id: cardId, patch: { completed: true } })
    const cards = getBoardView(channel.db)!.lists[0]!.cards.filter((c) => c.title === 'Pay rent')
    expect(cards.map((c) => [c.completed, c.repeat])).toEqual([
      [true, null],
      [false, { unit: 'month', every: 1 }]
    ])
    expect(cards[1]!.dueAt).toBeGreaterThan(Date.now())
  })

  it('refuses the internal spawn arm on the channel', async () => {
    const res = await fetch(`http://127.0.0.1:${channel.port}/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${channel.token}`
      },
      body: JSON.stringify({
        method: 'mutate',
        params: { type: 'card.spawnNext', id: cardId, copyId: 'x', toListId: listId }
      })
    })
    expect(res.ok).toBe(false)
  })
})
