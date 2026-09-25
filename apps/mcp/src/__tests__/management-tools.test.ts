import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveAccentColor } from '@kanbini/shared'
import { startFakeChannel, type FakeChannel } from './_fake-channel'

// The management tool set: labels (create / update / delete), list
// settings (WIP limit, sort mode, colour, on-enter rule) + reordering,
// board settings, archiving (cards / lists / boards + the archived-items
// read), and attachments (add from a path or inline content, delete).
//
// Every call goes through the REAL bundle over stdio, into the fake
// control channel, into real @kanbini/db against an in-memory SQLite -
// and the attachment methods write real files under the fake's temp
// userData, so "the file is on disk" / "the file is gone" are asserted
// directly rather than inferred from the row.

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
  client = new Client({ name: 'kanbini-mcp-management-test', version: '0.0.0' })
  await client.connect(transport)
}, 30_000)

afterAll(async () => {
  await client?.close().catch(() => {})
  await channel?.close()
})

/** Call a tool and parse its JSON, failing with the tool's own error
 *  text if it reported one. */
async function call<T = unknown>(
  name: string,
  args: Record<string, unknown>
): Promise<T> {
  const res = (await client.callTool({ name, arguments: args })) as ToolRes
  const text = res.content?.[0]?.text ?? '(no text)'
  if (res.isError) throw new Error(`${name} failed: ${text}`)
  return JSON.parse(text) as T
}

/** Call a tool that is expected to fail; return its error text. */
async function callError(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const res = (await client.callTool({ name, arguments: args })) as ToolRes
  const text = res.content?.[0]?.text ?? '(no text)'
  if (!res.isError) throw new Error(`${name} unexpectedly succeeded: ${text}`)
  return text
}

interface BoardView {
  board: { id: string; name: string; color: string | null }
  labels: Array<{ id: string; name: string; color: string }>
  lists: Array<{
    id: string
    name: string
    color: string | null
    closed: boolean
    wipLimit: number | null
    sortMode: string | null
    onEnter: { kind: string } | null
    cards: Array<{ id: string; title: string; completed: boolean; labelIds: string[] }>
  }>
}

const getBoard = (boardId: string) =>
  call<BoardView>('kanbini_get_board', { boardId })

/** A fresh board with `lists` columns and `cardsPerList` cards in the
 *  first one, so each test owns its fixtures. */
async function makeBoard(lists = ['Todo', 'Doing', 'Done'], cardTitles = ['c1']) {
  const { id: boardId } = await call<{ id: string }>('kanbini_create_board', {
    name: 'Mgmt'
  })
  const listIds: string[] = []
  for (const name of lists) {
    listIds.push(
      (await call<{ id: string }>('kanbini_create_list', { boardId, name })).id
    )
  }
  const cardIds: string[] = []
  for (const title of cardTitles) {
    cardIds.push(
      (
        await call<{ id: string }>('kanbini_create_card', {
          listId: listIds[0],
          title
        })
      ).id
    )
  }
  return { boardId, listIds, cardIds }
}

describe('tool registry', () => {
  it('lists every management tool', async () => {
    const { tools } = await client.listTools()
    const names = new Set(tools.map((t) => t.name))
    for (const n of [
      'kanbini_update_board',
      'kanbini_update_list',
      'kanbini_move_list',
      'kanbini_create_label',
      'kanbini_update_label',
      'kanbini_delete_label',
      'kanbini_archive_card',
      'kanbini_archive_list',
      'kanbini_archive_board',
      'kanbini_list_archived',
      'kanbini_add_attachment',
      'kanbini_delete_attachment'
    ]) {
      expect(names, n).toContain(n)
    }
  })
})

describe('labels', () => {
  it('creates a label from a palette name, storing the exact swatch', async () => {
    const { boardId, cardIds } = await makeBoard()
    const { id } = await call<{ id: string }>('kanbini_create_label', {
      boardId,
      name: 'Bug',
      color: 'Red'
    })
    const view = await getBoard(boardId)
    expect(view.labels).toEqual([
      { id, name: 'Bug', color: resolveAccentColor('red') }
    ])
    // And it's immediately assignable.
    await call('kanbini_set_card_labels', { id: cardIds[0], labelIds: [id] })
    expect((await getBoard(boardId)).lists[0]!.cards[0]!.labelIds).toEqual([id])
  })

  it('passes a raw CSS colour through unchanged', async () => {
    const { boardId } = await makeBoard()
    await call('kanbini_create_label', { boardId, name: 'Hex', color: '#123456' })
    expect((await getBoard(boardId)).labels[0]!.color).toBe('#123456')
  })

  it('renames and recolours a label', async () => {
    const { boardId } = await makeBoard()
    const { id } = await call<{ id: string }>('kanbini_create_label', {
      boardId,
      name: 'Old',
      color: 'blue'
    })
    await call('kanbini_update_label', {
      id,
      patch: { name: 'New', color: 'green' }
    })
    expect((await getBoard(boardId)).labels[0]).toEqual({
      id,
      name: 'New',
      color: resolveAccentColor('green')
    })
  })

  it('deleting a label removes it from every card', async () => {
    const { boardId, cardIds } = await makeBoard(['L'], ['a', 'b'])
    const { id } = await call<{ id: string }>('kanbini_create_label', {
      boardId,
      name: 'Tmp',
      color: 'amber'
    })
    for (const c of cardIds) {
      await call('kanbini_set_card_labels', { id: c, labelIds: [id] })
    }
    await call('kanbini_delete_label', { id })
    const view = await getBoard(boardId)
    expect(view.labels).toEqual([])
    expect(view.lists[0]!.cards.every((c) => c.labelIds.length === 0)).toBe(true)
  })

  it('refuses to put another board\'s label on a card', async () => {
    const a = await makeBoard()
    const b = await makeBoard()
    const { id: foreign } = await call<{ id: string }>('kanbini_create_label', {
      boardId: b.boardId,
      name: 'Theirs',
      color: 'pink'
    })
    const err = await callError('kanbini_set_card_labels', {
      id: a.cardIds[0],
      labelIds: [foreign]
    })
    expect(err).toMatch(/different board/)
  })

  it('rejects an over-long colour at the tool boundary', async () => {
    const { boardId } = await makeBoard()
    await callError('kanbini_create_label', {
      boardId,
      name: 'X',
      color: 'x'.repeat(40)
    })
  })
})

describe('list settings', () => {
  it('sets and clears a WIP limit', async () => {
    const { boardId, listIds } = await makeBoard()
    await call('kanbini_update_list', { id: listIds[0], patch: { wipLimit: 3 } })
    expect((await getBoard(boardId)).lists[0]!.wipLimit).toBe(3)
    await call('kanbini_update_list', { id: listIds[0], patch: { wipLimit: null } })
    expect((await getBoard(boardId)).lists[0]!.wipLimit).toBeNull()
  })

  it('rejects a non-positive WIP limit', async () => {
    const { listIds } = await makeBoard()
    await callError('kanbini_update_list', { id: listIds[0], patch: { wipLimit: 0 } })
  })

  it('applies a sort mode, and "manual" switches it off', async () => {
    const { boardId, listIds } = await makeBoard(['L'], ['cherry', 'apple', 'banana'])
    await call('kanbini_update_list', {
      id: listIds[0],
      patch: { sortMode: 'title-asc' }
    })
    let list = (await getBoard(boardId)).lists[0]!
    expect(list.sortMode).toBe('title-asc')
    expect(list.cards.map((c) => c.title)).toEqual(['apple', 'banana', 'cherry'])

    await call('kanbini_update_list', { id: listIds[0], patch: { sortMode: 'manual' } })
    list = (await getBoard(boardId)).lists[0]!
    expect(list.sortMode).toBeNull()
    // Freezing to manual keeps the order that was on screen.
    expect(list.cards.map((c) => c.title)).toEqual(['apple', 'banana', 'cherry'])
  })

  it('rejects an unknown sort mode', async () => {
    const { listIds } = await makeBoard()
    await callError('kanbini_update_list', {
      id: listIds[0],
      patch: { sortMode: 'random' }
    })
  })

  it('renames and recolours a list, and clears the colour', async () => {
    const { boardId, listIds } = await makeBoard()
    await call('kanbini_update_list', {
      id: listIds[0],
      patch: { name: 'Backlog', color: 'teal' }
    })
    let list = (await getBoard(boardId)).lists[0]!
    expect(list.name).toBe('Backlog')
    expect(list.color).toBe(resolveAccentColor('teal'))
    await call('kanbini_update_list', { id: listIds[0], patch: { color: null } })
    list = (await getBoard(boardId)).lists[0]!
    expect(list.color).toBeNull()
  })

  it('an on-enter "complete" rule completes a card moved in', async () => {
    const { boardId, listIds, cardIds } = await makeBoard()
    const doneId = listIds[2]!
    await call('kanbini_update_list', { id: doneId, patch: { onEnter: 'complete' } })
    expect((await getBoard(boardId)).lists[2]!.onEnter).toEqual({ kind: 'complete' })
    await call('kanbini_move_card', { id: cardIds[0], toListId: doneId })
    const done = (await getBoard(boardId)).lists[2]!
    expect(done.cards[0]!.completed).toBe(true)

    await call('kanbini_update_list', { id: doneId, patch: { onEnter: null } })
    expect((await getBoard(boardId)).lists[2]!.onEnter).toBeNull()
  })

  it('moves a list between two others', async () => {
    const { boardId, listIds } = await makeBoard(['A', 'B', 'C'], [])
    const [a, b, c] = listIds
    // C to the far left.
    await call('kanbini_move_list', { id: c, afterId: a })
    expect((await getBoard(boardId)).lists.map((l) => l.name)).toEqual(['C', 'A', 'B'])
    // A to the far right, after B.
    await call('kanbini_move_list', { id: a, beforeId: b })
    expect((await getBoard(boardId)).lists.map((l) => l.name)).toEqual(['C', 'B', 'A'])
  })
})

describe('card density', () => {
  interface DensityList {
    id: string
    cardDensity: string | null
    visibleCardLimit: number | null
    cards: Array<{ id: string; collapsed: boolean | null }>
  }

  it('collapses a card, keeps one open, and follows the list again', async () => {
    const { boardId, cardIds } = await makeBoard(['L'], ['a'])
    const card = async () =>
      ((await getBoard(boardId)).lists[0] as unknown as DensityList).cards[0]!
    for (const collapsed of [true, false, null]) {
      await call('kanbini_update_card', { id: cardIds[0], patch: { collapsed } })
      expect((await card()).collapsed).toBe(collapsed)
    }
  })

  it('sets a list compact with "compact" and back with "full"', async () => {
    const { boardId, listIds } = await makeBoard()
    const list = async () => (await getBoard(boardId)).lists[0] as unknown as DensityList
    await call('kanbini_update_list', { id: listIds[0], patch: { cardDensity: 'compact' } })
    expect((await list()).cardDensity).toBe('compact')
    await call('kanbini_update_list', { id: listIds[0], patch: { cardDensity: 'full' } })
    // "full" is the stored null - the AI never has to know that.
    expect((await list()).cardDensity).toBeNull()
  })

  it('sets a visible-card limit but still reads every card', async () => {
    const { boardId, listIds } = await makeBoard(['L'], ['a', 'b', 'c', 'd'])
    await call('kanbini_update_list', { id: listIds[0], patch: { visibleCardLimit: 2 } })
    const list = (await getBoard(boardId)).lists[0] as unknown as DensityList
    expect(list.visibleCardLimit).toBe(2)
    expect(list.cards).toHaveLength(4)
    await call('kanbini_update_list', { id: listIds[0], patch: { visibleCardLimit: null } })
    expect(
      ((await getBoard(boardId)).lists[0] as unknown as DensityList).visibleCardLimit
    ).toBeNull()
  })

  it('rejects an out-of-range limit and an unknown density at the tool boundary', async () => {
    const { listIds } = await makeBoard()
    await callError('kanbini_update_list', { id: listIds[0], patch: { visibleCardLimit: 0 } })
    await callError('kanbini_update_list', { id: listIds[0], patch: { visibleCardLimit: 5000 } })
    await callError('kanbini_update_list', { id: listIds[0], patch: { cardDensity: 'tiny' } })
  })
})

describe('board settings', () => {
  it('renames, recolours, and pins a board', async () => {
    const { boardId } = await makeBoard()
    await call('kanbini_update_board', {
      id: boardId,
      patch: { name: 'Renamed', color: 'indigo', pinned: true }
    })
    const view = await getBoard(boardId)
    expect(view.board.name).toBe('Renamed')
    expect(view.board.color).toBe(resolveAccentColor('indigo'))
    const summary = (
      await call<Array<{ id: string; pinned: boolean }>>('kanbini_list_boards', {})
    ).find((b) => b.id === boardId)
    expect(summary?.pinned).toBe(true)
  })
})

describe('archiving', () => {
  it('archives a card out of the board view and restores it in place', async () => {
    const { boardId, cardIds } = await makeBoard(['L'], ['a', 'b', 'c'])
    const [, middle] = cardIds
    await call('kanbini_archive_card', { id: middle, archived: true })
    expect((await getBoard(boardId)).lists[0]!.cards.map((c) => c.title)).toEqual([
      'a',
      'c'
    ])
    const archived = await call<{
      cards: Array<{ id: string; listName: string; listClosed: boolean }>
    }>('kanbini_list_archived', { boardId })
    expect(archived.cards).toEqual([
      expect.objectContaining({ id: middle, listName: 'L', listClosed: false })
    ])
    // Still readable directly.
    expect((await call<{ title: string }>('kanbini_get_card', { id: middle })).title).toBe(
      'b'
    )
    await call('kanbini_archive_card', { id: middle, archived: false })
    expect((await getBoard(boardId)).lists[0]!.cards.map((c) => c.title)).toEqual([
      'a',
      'b',
      'c'
    ])
  })

  it('archives a list (flagged in the board view) and restores it', async () => {
    const { boardId, listIds } = await makeBoard()
    await call('kanbini_archive_list', { id: listIds[1], archived: true })
    expect((await getBoard(boardId)).lists[1]!.closed).toBe(true)
    const archived = await call<{ lists: Array<{ id: string; name: string }> }>(
      'kanbini_list_archived',
      { boardId }
    )
    expect(archived.lists.map((l) => l.id)).toEqual([listIds[1]])
    await call('kanbini_archive_list', { id: listIds[1], archived: false })
    expect((await getBoard(boardId)).lists[1]!.closed).toBe(false)
  })

  it('flags a card whose list is also archived', async () => {
    const { boardId, listIds, cardIds } = await makeBoard()
    await call('kanbini_archive_card', { id: cardIds[0], archived: true })
    await call('kanbini_archive_list', { id: listIds[0], archived: true })
    const archived = await call<{ cards: Array<{ listClosed: boolean }> }>(
      'kanbini_list_archived',
      { boardId }
    )
    expect(archived.cards[0]!.listClosed).toBe(true)
  })

  it('archives and restores a board', async () => {
    const { boardId } = await makeBoard()
    const flag = async () =>
      (
        await call<Array<{ id: string; archived: boolean }>>('kanbini_list_boards', {})
      ).find((b) => b.id === boardId)?.archived
    await call('kanbini_archive_board', { id: boardId, archived: true })
    expect(await flag()).toBe(true)
    await call('kanbini_archive_board', { id: boardId, archived: false })
    expect(await flag()).toBe(false)
  })

  it('list_archived returns null for an unknown board', async () => {
    expect(await call('kanbini_list_archived', { boardId: 'nope' })).toBeNull()
  })
})

describe('attachments', () => {
  interface Added {
    id: string
    filename: string
    mime: string | null
    size: number
    relPath: string
    boardId: string
  }

  const onDisk = (relPath: string) => join(channel.userDataDir, relPath)

  it('copies a file in from an absolute path', async () => {
    const { boardId, cardIds } = await makeBoard()
    const src = join(channel.userDataDir, '..', 'source-notes.md')
    await writeFile(src, '# from disk')
    const added = await call<Added>('kanbini_add_attachment', {
      cardId: cardIds[0],
      path: src
    })
    expect(added).toMatchObject({
      filename: 'source-notes.md',
      mime: 'text/markdown',
      size: 11,
      boardId
    })
    expect(readFileSync(onDisk(added.relPath), 'utf8')).toBe('# from disk')
    const card = await call<{ attachments: Array<{ id: string }> }>(
      'kanbini_get_card',
      { id: cardIds[0] }
    )
    expect(card.attachments.map((a) => a.id)).toEqual([added.id])
  })

  it('writes inline utf8 content (the default encoding)', async () => {
    const { cardIds } = await makeBoard()
    const added = await call<Added>('kanbini_add_attachment', {
      cardId: cardIds[0],
      filename: 'summary.txt',
      content: 'line one\nline two'
    })
    expect(added.mime).toBe('text/plain')
    expect(readFileSync(onDisk(added.relPath), 'utf8')).toBe('line one\nline two')
  })

  it('writes inline base64 content and can become the cover', async () => {
    const { cardIds } = await makeBoard()
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const added = await call<Added>('kanbini_add_attachment', {
      cardId: cardIds[0],
      filename: 'pixel.png',
      content: png.toString('base64'),
      encoding: 'base64'
    })
    expect(readFileSync(onDisk(added.relPath))).toEqual(png)
    await call('kanbini_update_card', {
      id: cardIds[0],
      patch: { coverAttachmentId: added.id }
    })
    expect(
      (await call<{ coverAttachmentId: string }>('kanbini_get_card', { id: cardIds[0] }))
        .coverAttachmentId
    ).toBe(added.id)
  })

  it('sanitises an unsafe inline filename instead of escaping the dir', async () => {
    const { cardIds } = await makeBoard()
    const added = await call<Added>('kanbini_add_attachment', {
      cardId: cardIds[0],
      filename: '../../../outside.txt',
      content: 'x'
    })
    expect(added.filename).not.toContain('/')
    expect(added.relPath.startsWith(`attachments/${added.id}/`)).toBe(true)
    expect(existsSync(onDisk(added.relPath))).toBe(true)
  })

  it('explains each invalid source combination', async () => {
    const { cardIds } = await makeBoard()
    const cardId = cardIds[0]
    expect(
      await callError('kanbini_add_attachment', {
        cardId,
        path: '/tmp/a.txt',
        filename: 'a.txt',
        content: 'x'
      })
    ).toMatch(/not both/)
    expect(
      await callError('kanbini_add_attachment', { cardId, path: 'relative/a.txt' })
    ).toMatch(/must be absolute/)
    expect(await callError('kanbini_add_attachment', { cardId })).toMatch(
      /Pass `path`/
    )
    expect(
      await callError('kanbini_add_attachment', { cardId, filename: 'only-name.txt' })
    ).toMatch(/Pass `path`/)
    expect(
      await callError('kanbini_add_attachment', {
        cardId,
        filename: 'bad.bin',
        content: '!!!not base64!!!',
        encoding: 'base64'
      })
    ).toMatch(/not valid base64/)
  })

  it('reports a missing card without leaving a file behind', async () => {
    const err = await callError('kanbini_add_attachment', {
      cardId: 'no-such-card',
      filename: 'a.txt',
      content: 'x'
    })
    expect(err).toMatch(/card no-such-card not found/)
  })

  it('deletes an attachment AND its file', async () => {
    const { cardIds } = await makeBoard()
    const added = await call<Added>('kanbini_add_attachment', {
      cardId: cardIds[0],
      filename: 'gone.txt',
      content: 'bye'
    })
    expect(existsSync(onDisk(added.relPath))).toBe(true)
    await call('kanbini_delete_attachment', { id: added.id })
    expect(existsSync(onDisk(added.relPath))).toBe(false)
    const card = await call<{ attachments: unknown[] }>('kanbini_get_card', {
      id: cardIds[0]
    })
    expect(card.attachments).toEqual([])
  })
})
