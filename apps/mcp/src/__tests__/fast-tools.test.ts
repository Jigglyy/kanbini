import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getBoardView, getCardView, undoOne } from '@kanbini/db'
import { startFakeChannel, type FakeChannel } from './_fake-channel'

// The tools that make the AI faster: the light board read, the list
// read with filters and pages, one-call card creation, names / #numbers
// in place of ids, and kanbini_batch. Through the REAL bundle over stdio
// into the fake control channel and real @kanbini/db.

const here = dirname(fileURLToPath(import.meta.url))
const SERVER_PATH = resolve(here, '../../dist/index.js')
if (!existsSync(SERVER_PATH)) {
  throw new Error(`MCP bundle missing at ${SERVER_PATH}. Run \`pnpm --filter @kanbini/mcp run build\` first.`)
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
  client = new Client({ name: 'kanbini-mcp-fast-tools-test', version: '0.0.0' })
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

let boardSeq = 0
/** A fresh, uniquely named board with To Do / Done and some cards. */
async function makeBoard(cards = ['Alpha', 'Beta', 'Gamma']) {
  const name = `Fast ${++boardSeq}`
  const { id: boardId } = await call<{ id: string }>('kanbini_create_board', { name })
  await call('kanbini_create_list', { boardId: name, name: 'To Do' })
  await call('kanbini_create_list', { boardId: name, name: 'Done' })
  for (const title of cards) {
    await call('kanbini_create_card', { boardId: name, listId: 'To Do', title })
  }
  return { boardId, name }
}

const view = (boardId: string) => getBoardView(channel.db, boardId)!
const listCards = (boardId: string, list: string) =>
  view(boardId).lists.find((l) => l.name === list)!.cards

interface Summary {
  board: { id: string; name: string }
  labels: Array<{ id: string; name: string }>
  lists: Array<{ id: string; name: string; cardCount: number; cards: Array<Record<string, unknown>> }>
}

describe('kanbini_get_board', () => {
  it('gives one short line per card by default, named by number', async () => {
    const { boardId, name } = await makeBoard()
    await call('kanbini_create_label', { boardId, name: 'Bug', color: 'red' })
    await call('kanbini_set_card_labels', { id: '#2', boardId: name, labelIds: ['Bug'] })
    const s = await call<Summary>('kanbini_get_board', { boardId: name })
    expect(s.board).toEqual({ id: boardId, name })
    const todo = s.lists.find((l) => l.name === 'To Do')!
    expect(todo.cardCount).toBe(3)
    expect(todo.cards).toEqual([
      { number: 1, title: 'Alpha' },
      { number: 2, title: 'Beta', labels: ['Bug'] },
      { number: 3, title: 'Gamma' }
    ])
  })

  it('is far smaller than the full view, which is still there on request', async () => {
    const { boardId } = await makeBoard()
    for (const c of listCards(boardId, 'To Do')) {
      await call('kanbini_update_card', { id: c.id, patch: { description: 'x'.repeat(400) } })
      await call('kanbini_post_comment', { cardId: c.id, body: 'y'.repeat(400) })
    }
    const light = (await client.callTool({ name: 'kanbini_get_board', arguments: { boardId } })) as ToolRes
    const full = (await client.callTool({
      name: 'kanbini_get_board',
      arguments: { boardId, detail: 'full' }
    })) as ToolRes
    const size = (r: ToolRes) => r.content![0]!.text!.length
    expect(size(light) * 5).toBeLessThan(size(full))
    expect(JSON.parse(full.content![0]!.text!).lists[0].cards[0].description).toBe('x'.repeat(400))
  })
})

describe('kanbini_get_list_cards', () => {
  it('filters a list by status, label, priority, due and text', async () => {
    const { boardId, name } = await makeBoard(['Login bug', 'Docs', 'Polish', 'Signup bug'])
    await call('kanbini_create_label', { boardId, name: 'Bug', color: 'red' })
    await call('kanbini_batch', {
      boardId: name,
      steps: [
        { op: 'set_card_labels', id: '#1', labelIds: ['Bug'] },
        { op: 'set_card_labels', id: '#4', labelIds: ['bug'] },
        { op: 'update_card', id: '#1', patch: { completed: true } },
        { op: 'update_card', id: '#4', patch: { priority: 'high', due: '2026-11-20' } },
        { op: 'update_card', id: '#2', patch: { description: 'covers the LOGIN page' } }
      ]
    })
    type Page = { matched: number; cards: Array<{ number: number }>; more?: true }
    const nums = (p: Page) => p.cards.map((c) => c.number)
    const get = (f: Record<string, unknown>) =>
      call<Page>('kanbini_get_list_cards', { boardId: name, listId: 'to do', ...f })
    expect(nums(await get({ label: 'Bug' }))).toEqual([1, 4])
    expect(nums(await get({ label: 'Bug', status: 'open' }))).toEqual([4])
    expect(nums(await get({ priority: 'high' }))).toEqual([4])
    expect(nums(await get({ dueFrom: '2026-11-20', dueTo: '2026-11-20' }))).toEqual([4])
    expect(nums(await get({ dueTo: '2026-11-19' }))).toEqual([])
    expect(nums(await get({ query: 'login' }))).toEqual([1, 2])
  })

  it('pages through a long list', async () => {
    const titles = Array.from({ length: 7 }, (_, i) => `Card ${i + 1}`)
    const { name } = await makeBoard(titles)
    type Page = { matched: number; offset: number; cards: Array<{ number: number }>; more?: true }
    const p1 = await call<Page>('kanbini_get_list_cards', { boardId: name, listId: 'To Do', limit: 3 })
    expect(p1).toMatchObject({ matched: 7, offset: 0, more: true })
    expect(p1.cards.map((c) => c.number)).toEqual([1, 2, 3])
    const p3 = await call<Page>('kanbini_get_list_cards', { boardId: name, listId: 'To Do', limit: 3, offset: 6 })
    expect(p3.cards.map((c) => c.number)).toEqual([7])
    expect(p3.more).toBeUndefined()
  })

  it('names the lists there when the list name is wrong', async () => {
    const { name } = await makeBoard()
    expect(await callError('kanbini_get_list_cards', { boardId: name, listId: 'Doing' })).toMatch(
      /No list named "Doing".*"To Do", "Done"/
    )
  })
})

describe('kanbini_create_card in one call', () => {
  it('makes the whole card, as one undo step', async () => {
    const { boardId, name } = await makeBoard([])
    await call('kanbini_create_label', { boardId, name: 'Bug', color: 'red' })
    const { id } = await call<{ id: string }>('kanbini_create_card', {
      boardId: name,
      listId: 'To Do',
      title: 'Ship it',
      description: 'First line\\nSecond line',
      due: '2026-12-01',
      priority: 'urgent',
      labels: ['bug'],
      checklists: [{ name: 'Steps', items: ['Build', 'Test'] }]
    })
    const card = getCardView(channel.db, id)!
    expect(card).toMatchObject({
      title: 'Ship it',
      description: 'First line\nSecond line',
      priority: 'urgent',
      dueAt: new Date(2026, 11, 1).getTime()
    })
    expect(card.labelIds).toEqual([view(boardId).labels[0]!.id])
    expect(card.checklists.map((c) => [c.name, c.items.map((i) => i.text)])).toEqual([['Steps', ['Build', 'Test']]])
    // One Ctrl+Z takes the whole card back.
    undoOne(channel.db, boardId)
    expect(listCards(boardId, 'To Do')).toEqual([])
  })

  it('can place the card under another one', async () => {
    const { boardId, name } = await makeBoard(['First', 'Last'])
    await call('kanbini_create_card', { boardId: name, listId: 'To Do', title: 'Middle', beforeId: '#1' })
    expect(listCards(boardId, 'To Do').map((c) => c.title)).toEqual(['First', 'Middle', 'Last'])
  })

  it('refuses a label the board does not have, saying which it has', async () => {
    const { boardId, name } = await makeBoard([])
    await call('kanbini_create_label', { boardId, name: 'Bug', color: 'red' })
    expect(
      await callError('kanbini_create_card', { boardId: name, listId: 'To Do', title: 'X', labels: ['Perf'] })
    ).toMatch(/No label named "Perf".*"Bug"/)
    expect(listCards(boardId, 'To Do')).toEqual([])
  })
})

describe('names and #numbers instead of ids', () => {
  it('moves, updates and relabels cards named by number, onto lists named by name', async () => {
    const { boardId, name } = await makeBoard()
    await call('kanbini_create_label', { boardId: name, name: 'Bug', color: 'red' })
    await call('kanbini_create_label', { boardId: name, name: 'UI', color: 'blue' })
    await call('kanbini_move_card', { id: '#2', boardId: name, toListId: 'done' })
    await call('kanbini_update_card', { id: '#3', boardId: name, patch: { due: '2026-11-09' } })
    await call('kanbini_set_card_labels', { id: '#1', boardId: name, labelIds: ['Bug', 'UI'] })
    await call('kanbini_set_card_labels', { id: '#1', boardId: name, labelIds: ['UI'], mode: 'remove' })
    await call('kanbini_set_card_labels', { id: '#3', boardId: name, labelIds: ['UI'], mode: 'add' })
    const v = view(boardId)
    const by = (n: number) => v.lists.flatMap((l) => l.cards).find((c) => c.number === n)!
    const label = (n: string) => v.labels.find((l) => l.name === n)!.id
    expect(v.lists.find((l) => l.name === 'Done')!.cards.map((c) => c.number)).toEqual([2])
    expect(by(3).dueAt).toBe(new Date(2026, 10, 9).getTime())
    expect(by(1).labelIds).toEqual([label('Bug')])
    expect(by(3).labelIds).toEqual([label('UI')])
  })

  it('says a number or name needs a board', async () => {
    await makeBoard()
    expect(await callError('kanbini_update_card', { id: '#1', patch: { title: 'x' } })).toMatch(/pass `boardId`/)
    expect(await callError('kanbini_update_list', { id: 'To Do', patch: { name: 'x' } })).toMatch(/pass `boardId`/)
  })
})

describe('kanbini_batch', () => {
  it('builds lists, labels and cards in one call, using refs and new names', async () => {
    const { boardId, name } = await makeBoard(['Old'])
    const res = await call<{ changes: number; steps: Array<{ step: number; op: string; id: string; ref?: string }> }>(
      'kanbini_batch',
      {
        boardId: name,
        steps: [
          { op: 'create_list', name: 'Sprint 4', ref: 's4' },
          { op: 'create_label', name: 'Perf', color: 'amber' },
          { op: 'create_card', listId: '$s4', title: 'Profile drags', labels: ['Perf'], ref: 'prof' },
          { op: 'create_card', listId: 'Sprint 4', title: 'Fix it', beforeId: '$prof' },
          { op: 'add_blocker', cardId: '$prof', blockerId: '#1' },
          { op: 'move_card', id: '#1', toListId: 'Done' },
          { op: 'post_comment', cardId: '$prof', body: 'Started' }
        ]
      }
    )
    expect(res.steps.map((s) => s.op)).toEqual([
      'create_list',
      'create_label',
      'create_card',
      'create_card',
      'add_blocker',
      'move_card',
      'post_comment'
    ])
    expect(res.steps[0]).toMatchObject({ step: 1, ref: 's4' })
    const v = view(boardId)
    const sprint = v.lists.find((l) => l.name === 'Sprint 4')!
    expect(sprint.id).toBe(res.steps[0]!.id)
    expect(sprint.cards.map((c) => c.title)).toEqual(['Profile drags', 'Fix it'])
    expect(sprint.cards[0]!.labelIds).toEqual([v.labels.find((l) => l.name === 'Perf')!.id])
    expect(sprint.cards[0]!.blockedBy.map((b) => b.title)).toEqual(['Old'])
    expect(sprint.cards[0]!.comments.map((c) => c.body)).toEqual(['Started'])
    expect(v.lists.find((l) => l.name === 'Done')!.cards.map((c) => c.title)).toEqual(['Old'])

    // The whole batch is one Ctrl+Z.
    undoOne(channel.db, boardId)
    const after = view(boardId)
    expect(after.lists.map((l) => l.name)).toEqual(['To Do', 'Done'])
    expect(after.labels).toEqual([])
    expect(after.lists[0]!.cards.map((c) => c.title)).toEqual(['Old'])
  })

  it('changes nothing when a step fails in the app, and says which step', async () => {
    const { boardId, name } = await makeBoard()
    const before = JSON.stringify(view(boardId))
    const msg = await callError('kanbini_batch', {
      boardId: name,
      steps: [
        { op: 'update_card', id: '#1', patch: { title: 'Renamed' } },
        { op: 'archive_card', id: '#2', archived: true },
        { op: 'add_blocker', cardId: '#3', blockerId: '#3' }
      ]
    })
    expect(msg).toMatch(/^Step 3 \(add_blocker\) failed, so nothing was changed:/)
    expect(JSON.stringify(view(boardId))).toBe(before)
  })

  it('checks every step before changing anything', async () => {
    const { boardId, name } = await makeBoard()
    const before = JSON.stringify(view(boardId))
    expect(
      await callError('kanbini_batch', {
        boardId: name,
        steps: [
          { op: 'update_card', id: '#1', patch: { title: 'Renamed' } },
          { op: 'move_card', id: '#2', toListId: 'Doing' }
        ]
      })
    ).toMatch(/^Step 2 \(move_card\): No list named "Doing"/)
    expect(
      await callError('kanbini_batch', { boardId: name, steps: [{ op: 'archive_card', id: '#1', archive: true }] })
    ).toMatch(/^Step 1 \(archive_card\):[\s\S]*archive/)
    expect(
      await callError('kanbini_batch', { boardId: name, steps: [{ op: 'update_card', id: '#1', patch: {}, ref: 'x' }] })
    ).toMatch(/update_card creates nothing/)
    expect(JSON.stringify(view(boardId))).toBe(before)
  })

  it('can make a whole new board, filled in, in one call', async () => {
    const res = await call<{ steps: Array<{ id: string }> }>('kanbini_batch', {
      steps: [
        { op: 'create_board', name: 'Launch plan', ref: 'b' },
        { op: 'create_list', boardId: '$b', name: 'Next' },
        { op: 'create_label', boardId: '$b', name: 'Web', color: 'blue' },
        { op: 'create_card', boardId: '$b', listId: 'Next', title: 'Landing page', labels: ['Web'] }
      ]
    })
    const v = view(res.steps[0]!.id)
    expect(v.board.name).toBe('Launch plan')
    expect(v.lists[0]!.cards.map((c) => [c.title, c.labelIds.length])).toEqual([['Landing page', 1]])
  })
})
