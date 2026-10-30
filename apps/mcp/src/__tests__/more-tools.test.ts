import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFakeChannel, type FakeChannel } from './_fake-channel'

// The tools that filled the gaps an AI kept hitting: editing / deleting
// checklists, checklist items and comments, deleting lists and boards,
// copying cards, naming cards by number (#142 + boardId) in the write
// tools, and card numbers in "waiting on" links and agenda rows. Real
// bundle over stdio -> fake control channel -> real @kanbini/db.

const here = dirname(fileURLToPath(import.meta.url))
const SERVER_PATH = resolve(here, '../../dist/index.js')

if (!existsSync(SERVER_PATH)) {
  throw new Error(
    `MCP bundle missing at ${SERVER_PATH}. Run \`pnpm --filter @kanbini/mcp run build\` first.`
  )
}

type ToolRes = { content?: Array<{ text?: string } | undefined>; isError?: boolean }

let channel: FakeChannel
let client: Client

beforeAll(async () => {
  channel = await startFakeChannel({ seed: false })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env: { ...process.env, KANBINI_USERDATA_OVERRIDE: channel.userDataDir }
  })
  client = new Client({ name: 'kanbini-mcp-more-tools-test', version: '0.0.0' })
  await client.connect(transport)
}, 30_000)

afterAll(async () => {
  await client?.close().catch(() => {})
  await channel?.close()
})

async function call<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = (await client.callTool({ name, arguments: args })) as ToolRes
  const text = res.content?.[0]?.text ?? '(no text)'
  if (res.isError) throw new Error(`${name} failed: ${text}`)
  return JSON.parse(text) as T
}

async function callError(name: string, args: Record<string, unknown>): Promise<string> {
  const res = (await client.callTool({ name, arguments: args })) as ToolRes
  const text = res.content?.[0]?.text ?? '(no text)'
  if (!res.isError) throw new Error(`${name} unexpectedly succeeded: ${text}`)
  return text
}

interface Card {
  id: string
  number: number
  boardId: string
  title: string
  completed: boolean
  labelIds: string[]
  checklists: Array<{ id: string; name: string; items: Array<{ id: string; text: string; completed: boolean }> }>
  comments: Array<{ id: string; body: string; author: string | null }>
  blockedBy: Array<{ cardId: string; number: number; title: string }>
}
interface Board {
  board: { id: string; name: string }
  labels: Array<{ id: string; name: string; color: string }>
  lists: Array<{ id: string; name: string; cards: Array<{ id: string; number: number; title: string }> }>
}

const getCard = (id: string) => call<Card>('kanbini_get_card', { id })
const getBoard = (boardId: string) => call<Board>('kanbini_get_board', { boardId })
const created = async (name: string, args: Record<string, unknown>) =>
  (await call<{ id: string }>(name, args)).id

async function makeBoard(name: string, lists = ['Todo', 'Done'], titles = ['A', 'B']) {
  const boardId = await created('kanbini_create_board', { name })
  const listIds: string[] = []
  for (const l of lists) listIds.push(await created('kanbini_create_list', { boardId, name: l }))
  const cardIds: string[] = []
  for (const t of titles) cardIds.push(await created('kanbini_create_card', { listId: listIds[0], title: t }))
  return { boardId, listIds, cardIds }
}

describe('tool registry', () => {
  it('lists the new tools', async () => {
    const { tools } = await client.listTools()
    const names = new Set(tools.map((t) => t.name))
    for (const n of [
      'kanbini_copy_card',
      'kanbini_update_comment',
      'kanbini_delete_comment',
      'kanbini_rename_checklist',
      'kanbini_delete_checklist',
      'kanbini_update_checklist_item',
      'kanbini_move_checklist_item',
      'kanbini_delete_checklist_item',
      'kanbini_delete_list',
      'kanbini_delete_board'
    ]) {
      expect(names, n).toContain(n)
    }
  })
})

describe('card numbers in write tools', () => {
  it('a card can be named #N with its board', async () => {
    const { boardId, cardIds } = await makeBoard('Numbers')
    const { number } = await getCard(cardIds[1]!)
    await call('kanbini_update_card', { id: `#${number}`, boardId, patch: { title: 'B, by number' } })
    expect((await getCard(cardIds[1]!)).title).toBe('B, by number')
    // A bare number works too, and so do the other card tools.
    await call('kanbini_post_comment', { cardId: String(number), boardId, body: 'hi' })
    expect((await getCard(cardIds[1]!)).comments.map((c) => c.body)).toEqual(['hi'])
  })

  it('a number without its board, or one not on it, is a clear error', async () => {
    const { boardId } = await makeBoard('Numbers 2')
    expect(await callError('kanbini_delete_card', { id: '#1' })).toMatch(/boardId/)
    expect(await callError('kanbini_delete_card', { id: '#999', boardId })).toMatch(/no card #999/)
  })

  it('move takes numbers for the card and its neighbours', async () => {
    const { boardId, listIds } = await makeBoard('Numbers 3', ['Todo'], ['A', 'B', 'C'])
    const view = await getBoard(boardId)
    const [a, , c] = view.lists[0]!.cards
    await call('kanbini_move_card', { id: `#${c!.number}`, boardId, toListId: listIds[0], afterId: `#${a!.number}` })
    expect((await getBoard(boardId)).lists[0]!.cards.map((x) => x.title)).toEqual(['C', 'A', 'B'])
  })

  it('blockers take numbers, and the links read back with them', async () => {
    const { boardId, cardIds } = await makeBoard('Numbers 4')
    const a = await getCard(cardIds[0]!)
    const b = await getCard(cardIds[1]!)
    await call('kanbini_add_blocker', { cardId: `#${a.number}`, blockerId: `#${b.number}`, boardId })
    const blocked = await getCard(a.id)
    expect(blocked.blockedBy.map((r) => [r.cardId, r.number])).toEqual([[b.id, b.number]])
  })
})

describe('kanbini_copy_card', () => {
  it('copies right under the original with its checklist', async () => {
    const { boardId, listIds, cardIds } = await makeBoard('Copy')
    const cl = await created('kanbini_create_checklist', { cardId: cardIds[0], name: 'Steps' })
    await created('kanbini_add_checklist_item', { checklistId: cl, text: 'one' })
    const res = await call<{ id: string }>('kanbini_copy_card', {
      id: cardIds[0],
      toListId: listIds[0],
      beforeId: cardIds[0]
    })
    expect((await getBoard(boardId)).lists[0]!.cards.map((c) => c.title)).toEqual(['A', 'A', 'B'])
    const copy = await getCard(res.id)
    expect(copy.checklists[0]!.items.map((i) => i.text)).toEqual(['one'])
    expect(copy.number).not.toBe((await getCard(cardIds[0]!)).number)
  })

  it('copies to another board with a new title, bringing labels by name', async () => {
    const from = await makeBoard('Copy from')
    const to = await makeBoard('Copy to', ['Inbox'], [])
    const label = await created('kanbini_create_label', { boardId: from.boardId, name: 'Bug', color: 'red' })
    await call('kanbini_set_card_labels', { id: from.cardIds[0], labelIds: [label] })
    const res = await call<{ id: string; boardId: string }>('kanbini_copy_card', {
      id: from.cardIds[0],
      toListId: to.listIds[0],
      title: 'A (copy)'
    })
    expect(res.boardId).toBe(to.boardId)
    const copy = await getCard(res.id)
    expect(copy.title).toBe('A (copy)')
    const toLabels = (await getBoard(to.boardId)).labels
    expect(toLabels.map((l) => l.name)).toEqual(['Bug'])
    expect(copy.labelIds).toEqual([toLabels[0]!.id])
  })
})

describe('comments, checklists and items', () => {
  it('edits and deletes a comment', async () => {
    const { cardIds } = await makeBoard('Comments', ['Todo'], ['A'])
    const id = await created('kanbini_post_comment', { cardId: cardIds[0], body: 'first' })
    await call('kanbini_update_comment', { id, body: 'edited' })
    expect((await getCard(cardIds[0]!)).comments.map((c) => c.body)).toEqual(['edited'])
    await call('kanbini_delete_comment', { id })
    expect((await getCard(cardIds[0]!)).comments).toEqual([])
  })

  it('renames and deletes a checklist', async () => {
    const { cardIds } = await makeBoard('Checklists', ['Todo'], ['A'])
    const id = await created('kanbini_create_checklist', { cardId: cardIds[0], name: 'Old' })
    await call('kanbini_rename_checklist', { id, name: 'New' })
    expect((await getCard(cardIds[0]!)).checklists.map((c) => c.name)).toEqual(['New'])
    await call('kanbini_delete_checklist', { id })
    expect((await getCard(cardIds[0]!)).checklists).toEqual([])
  })

  it('edits, moves and deletes checklist items', async () => {
    const { cardIds } = await makeBoard('Items', ['Todo'], ['A', 'B'])
    const cl = await created('kanbini_create_checklist', { cardId: cardIds[0], name: 'Steps' })
    const one = await created('kanbini_add_checklist_item', { checklistId: cl, text: 'one' })
    const two = await created('kanbini_add_checklist_item', { checklistId: cl, text: 'two' })
    await call('kanbini_update_checklist_item', { id: one, text: 'one, reworded', completed: true })
    let items = (await getCard(cardIds[0]!)).checklists[0]!.items
    expect(items.map((i) => [i.text, i.completed])).toEqual([
      ['one, reworded', true],
      ['two', false]
    ])
    expect(await callError('kanbini_update_checklist_item', { id: two })).toMatch(/text.*completed/)

    // Reorder within the checklist: two above one.
    await call('kanbini_move_checklist_item', { id: two, toChecklistId: cl, afterId: one })
    items = (await getCard(cardIds[0]!)).checklists[0]!.items
    expect(items.map((i) => i.text)).toEqual(['two', 'one, reworded'])

    // To another card's checklist.
    const other = await created('kanbini_create_checklist', { cardId: cardIds[1], name: 'Other' })
    await call('kanbini_move_checklist_item', { id: two, toChecklistId: other })
    expect((await getCard(cardIds[1]!)).checklists[0]!.items.map((i) => i.text)).toEqual(['two'])

    await call('kanbini_delete_checklist_item', { id: one })
    expect((await getCard(cardIds[0]!)).checklists[0]!.items).toEqual([])
  })
})

describe('deleting lists and boards', () => {
  it('deletes a list with its cards', async () => {
    const { boardId, listIds, cardIds } = await makeBoard('Lists')
    await call('kanbini_delete_list', { id: listIds[0] })
    expect((await getBoard(boardId)).lists.map((l) => l.name)).toEqual(['Done'])
    expect(await getCard(cardIds[0]!)).toBeNull()
  })

  it('deletes a board', async () => {
    const { boardId } = await makeBoard('Doomed')
    await call('kanbini_delete_board', { id: boardId })
    const boards = await call<Array<{ id: string }>>('kanbini_list_boards', {})
    expect(boards.map((b) => b.id)).not.toContain(boardId)
  })
})

describe('agenda rows carry the card number', () => {
  it('names each card by its #N', async () => {
    const { cardIds } = await makeBoard('Agenda', ['Todo'], ['Due soon'])
    const today = new Date()
    today.setHours(12, 0, 0, 0)
    await call('kanbini_update_card', { id: cardIds[0], patch: { dueAt: today.getTime() } })
    const agenda = await call<{ today: Array<{ cardId: string; number: number }> }>('kanbini_get_agenda', {})
    const row = agenda.today.find((r) => r.cardId === cardIds[0])
    expect(row?.number).toBe((await getCard(cardIds[0]!)).number)
  })
})
