import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { getTableColumns } from 'drizzle-orm'
import { BOARD_FILE_JSON, BOARD_FILE_VERSION, type BoardFile, zBoardFile } from '@kanbini/shared'
import { addAttachmentFromBytes } from '../attachments'
import { exportBoardFile, importBoardFile, readBoardFile } from '../board-file'
import { applyMutation, ensureDefaultProjectId } from '../crud'
import { getArchivedItems, getBoardView, getCardView, listBoards } from '../data'
import {
  activity,
  attachment,
  board,
  card,
  cardDependency,
  cardLabel,
  checklist,
  checklistItem,
  comment,
  label,
  list
} from '../schema'
import { createTestDb, type TestDb } from './_setup'

// One board in one .kanbini file: 'lists' carries the board's set-up
// (look, labels, open lists and their settings), 'cards' everything on
// it. Importing always makes a NEW board with fresh ids and leaves the
// rest of the data alone.

let t: TestDb
let userDataDir: string
let outDir: string

beforeEach(() => {
  t = createTestDb()
  userDataDir = mkdtempSync(join(tmpdir(), 'kanbini-boardfile-'))
  outDir = mkdtempSync(join(tmpdir(), 'kanbini-boardfile-out-'))
})

afterEach(() => {
  t.close()
  rmSync(userDataDir, { recursive: true, force: true })
  rmSync(outDir, { recursive: true, force: true })
})

const m = (mutation: Parameters<typeof applyMutation>[1]) => applyMutation(t.db, mutation)

function seed() {
  const projectId = ensureDefaultProjectId(t.db)
  const boardId = m({ type: 'board.create', projectId, name: 'Garden' }).id
  m({ type: 'board.update', id: boardId, patch: { color: 'green', swimlaneMode: 'priority' } })
  const todo = m({ type: 'list.create', boardId, name: 'Todo' }).id
  const done = m({ type: 'list.create', boardId, name: 'Done' }).id
  const old = m({ type: 'list.create', boardId, name: 'Old stuff' }).id
  m({
    type: 'list.update',
    id: todo,
    patch: { color: 'red', wipLimit: 5, cardDensity: 'compact', visibleCardLimit: 3 }
  })
  m({ type: 'list.update', id: done, patch: { onEnter: { kind: 'complete' }, sortMode: 'title-asc' } })
  const urgent = m({ type: 'label.create', boardId, name: 'Urgent', color: 'red' }).id
  const later = m({ type: 'label.create', boardId, name: 'Later', color: 'blue' }).id

  const water = m({ type: 'card.create', listId: todo, title: 'Water plants' }).id
  const seeds = m({ type: 'card.create', listId: todo, title: 'Buy seeds' }).id
  const fence = m({ type: 'card.create', listId: done, title: 'Fix fence' }).id
  const shed = m({ type: 'card.create', listId: old, title: 'Paint shed' }).id
  m({ type: 'list.update', id: old, patch: { closed: true } })
  m({
    type: 'card.update',
    id: water,
    patch: {
      description: 'Every **morning**',
      dueAt: 1_800_000_000_000,
      priority: 'high',
      repeat: { unit: 'day', every: 1 },
      collapsed: true
    }
  })
  m({ type: 'card.setLabels', id: water, labelIds: [urgent, later] })
  m({ type: 'card.update', id: seeds, patch: { archived: true } })
  const cl = m({ type: 'checklist.create', cardId: water, name: 'Pots' }).id
  const item = m({ type: 'checklistItem.create', checklistId: cl, text: 'Front' }).id
  m({ type: 'checklistItem.create', checklistId: cl, text: 'Back' })
  m({ type: 'checklistItem.update', id: item, patch: { completed: true } })
  m({ type: 'comment.create', cardId: water, body: 'Use rain water' })
  m({ type: 'comment.create', cardId: water, body: 'Noted', author: 'ai' })
  m({ type: 'card.addBlocker', id: water, blockerId: fence })

  // A link to a card on another board can't come along.
  const other = m({ type: 'board.create', projectId, name: 'Other' }).id
  const otherList = m({ type: 'list.create', boardId: other, name: 'Inbox' }).id
  const elsewhere = m({ type: 'card.create', listId: otherList, title: 'Elsewhere' }).id
  m({ type: 'card.addBlocker', id: fence, blockerId: elsewhere })

  return { boardId, todo, done, old, water, seeds, fence, shed, urgent, later, other }
}

async function roundTrip(boardId: string, content: 'lists' | 'cards') {
  const path = join(outDir, `board-${content}.kanbini`)
  const result = await exportBoardFile(t.db, { userDataDir, boardId, content, destPath: path })
  const summary = await importBoardFile(t.db, { userDataDir, path })
  return { path, result, summary }
}

const zipEntries = (path: string) => unzipSync(new Uint8Array(readFileSync(path)))

describe("'lists' export", () => {
  it('brings the set-up and no cards', async () => {
    const s = seed()
    const { summary, path } = await roundTrip(s.boardId, 'lists')
    expect(summary.content).toBe('lists')
    expect(summary.counts).toEqual({ lists: 2, labels: 2, cards: 0, attachments: 0 })

    const view = getBoardView(t.db, summary.boardId)!
    expect(view.board.name).toBe('Garden')
    expect(view.board.color).toBe('green')
    expect(view.board.swimlaneMode).toBe('priority')
    expect(view.labels.map((l) => [l.name, l.color])).toEqual([
      ['Urgent', 'red'],
      ['Later', 'blue']
    ])
    // The closed list stays behind.
    expect(view.lists.map((l) => l.name)).toEqual(['Todo', 'Done'])
    const [todo, done] = view.lists
    expect(todo).toMatchObject({
      color: 'red',
      wipLimit: 5,
      cardDensity: 'compact',
      visibleCardLimit: 3,
      cards: []
    })
    expect(done).toMatchObject({ onEnter: { kind: 'complete' }, sortMode: 'title-asc', cards: [] })

    const json = JSON.parse(strFromU8(zipEntries(path)[BOARD_FILE_JSON]!)) as BoardFile
    expect(json.cards).toEqual([])
    expect(json.board.cardNumberLast).toBe(0)
  })

  it('starts the new board at card #1', async () => {
    const s = seed()
    const { summary } = await roundTrip(s.boardId, 'lists')
    const listId = getBoardView(t.db, summary.boardId)!.lists[0]!.id
    const id = m({ type: 'card.create', listId, title: 'First' }).id
    expect(getCardView(t.db, id)!.number).toBe(1)
  })
})

describe("'cards' export", () => {
  it('brings every card with what is on it, as a new board', async () => {
    const s = seed()
    const { summary } = await roundTrip(s.boardId, 'cards')
    expect(summary.counts).toEqual({ lists: 3, labels: 2, cards: 4, attachments: 0 })
    expect(summary.boardId).not.toBe(s.boardId)
    expect(listBoards(t.db).map((b) => b.name)).toEqual(['Garden', 'Other', 'Garden'])

    const before = getBoardView(t.db, s.boardId)!
    const after = getBoardView(t.db, summary.boardId)!
    const shape = (v: typeof before) =>
      v.lists.map((l) => ({
        name: l.name,
        closed: l.closed,
        cards: l.cards.map((c) => [c.number, c.title, c.completed])
      }))
    expect(shape(after)).toEqual(shape(before))

    const water = after.lists[0]!.cards.find((c) => c.title === 'Water plants')!
    const card = getCardView(t.db, water.id)!
    expect(card).toMatchObject({
      description: 'Every **morning**',
      dueAt: 1_800_000_000_000,
      priority: 'high',
      repeat: { unit: 'day', every: 1 },
      collapsed: true
    })
    const labelName = new Map(after.labels.map((l) => [l.id, l.name]))
    expect(card.labelIds.map((id) => labelName.get(id))).toEqual(['Urgent', 'Later'])
    expect(card.checklists[0]!.items.map((i) => [i.text, i.completed])).toEqual([
      ['Front', true],
      ['Back', false]
    ])
    expect(card.comments.map((c) => [c.body, c.author])).toEqual(
      expect.arrayContaining([
        ['Use rain water', null],
        ['Noted', 'ai']
      ])
    )
    // The waiting-on link between two cards of the board comes along...
    expect(card.blockedBy.map((r) => r.title)).toEqual(['Fix fence'])
    expect(card.blockedBy[0]!.boardId).toBe(summary.boardId)
    // ...the one to another board doesn't.
    const fence = after.lists[1]!.cards[0]!
    expect(getCardView(t.db, fence.id)!.blockedBy).toEqual([])
    expect(card.activities.length).toBeGreaterThan(0)
  })

  it('keeps archived cards and closed lists archived', async () => {
    const s = seed()
    const { summary } = await roundTrip(s.boardId, 'cards')
    const archived = getArchivedItems(t.db, summary.boardId)!
    expect(archived.lists.map((l) => l.name)).toEqual(['Old stuff'])
    expect(archived.cards.map((c) => c.title)).toEqual(['Buy seeds'])
  })

  it('keeps card numbers and the counter', async () => {
    const s = seed()
    m({ type: 'card.delete', id: s.shed }) // #4 retired on the source board
    const { summary } = await roundTrip(s.boardId, 'cards')
    const todo = getBoardView(t.db, summary.boardId)!.lists[0]!
    expect(todo.cards.map((c) => c.number)).toEqual([1])
    const next = m({ type: 'card.create', listId: todo.id, title: 'Next' }).id
    expect(getCardView(t.db, next)!.number).toBe(5)
  })

  it('imports the same file twice as two boards', async () => {
    const s = seed()
    const { path, summary } = await roundTrip(s.boardId, 'cards')
    const again = await importBoardFile(t.db, { userDataDir, path })
    expect(again.boardId).not.toBe(summary.boardId)
    expect(listBoards(t.db).filter((b) => b.name === 'Garden')).toHaveLength(3)
    const links = t.db.select().from(cardDependency).all()
    expect(links).toHaveLength(4) // 2 on the source + 1 per import
  })
})

describe('files', () => {
  it('packs shared attachment files once and unpacks them into new folders', async () => {
    const s = seed()
    const { attachment: a } = await addAttachmentFromBytes(t.db, {
      userDataDir,
      cardId: s.water,
      filename: 'photo.png',
      bytes: strToU8('PNGDATA')
    })
    m({ type: 'card.update', id: s.water, patch: { coverAttachmentId: a.id } })
    m({ type: 'card.copy', id: s.water, toListId: s.todo }) // shares photo.png

    const { path, summary } = await roundTrip(s.boardId, 'cards')
    const entries = Object.keys(zipEntries(path)).filter((n) => n.startsWith('attachments/'))
    expect(entries).toHaveLength(1)
    expect(summary.counts.attachments).toBe(2)

    const view = getBoardView(t.db, summary.boardId)!
    const copies = view.lists[0]!.cards.filter((c) => c.title === 'Water plants')
    expect(copies).toHaveLength(2)
    const rows = t.db
      .select()
      .from(attachment)
      .all()
      .filter((r) => copies.some((c) => c.id === r.cardId))
    expect(new Set(rows.map((r) => r.relPath)).size).toBe(1)
    const rel = rows[0]!.relPath
    expect(rel).not.toBe(a.relPath)
    expect(rel).toMatch(/^attachments\/[^/]+\/photo\.png$/)
    expect(readFileSync(join(userDataDir, rel), 'utf8')).toBe('PNGDATA')
    for (const c of copies) {
      expect(rows.some((r) => r.id === c.coverAttachmentId)).toBe(true)
    }
  })

  it('brings an image background', async () => {
    const s = seed()
    const relPath = `board-backgrounds/${s.boardId}/bg.jpg`
    mkdirSync(join(userDataDir, 'board-backgrounds', s.boardId), { recursive: true })
    writeFileSync(join(userDataDir, relPath), 'JPEGDATA')
    m({ type: 'board.update', id: s.boardId, patch: { background: { kind: 'image', relPath } } })

    const { summary } = await roundTrip(s.boardId, 'lists')
    const bg = getBoardView(t.db, summary.boardId)!.board.background
    expect(bg?.kind).toBe('image')
    const newRel = bg?.kind === 'image' ? bg.relPath : ''
    expect(newRel.startsWith(`board-backgrounds/${summary.boardId}/`)).toBe(true)
    expect(newRel.endsWith('.jpg')).toBe(true)
    expect(readFileSync(join(userDataDir, newRel), 'utf8')).toBe('JPEGDATA')
  })

  it('leaves out an attachment whose file is gone, and its cover', async () => {
    const s = seed()
    const { attachment: a } = await addAttachmentFromBytes(t.db, {
      userDataDir,
      cardId: s.water,
      filename: 'gone.png',
      bytes: strToU8('X')
    })
    m({ type: 'card.update', id: s.water, patch: { coverAttachmentId: a.id } })
    rmSync(join(userDataDir, a.relPath))

    const { result, summary } = await roundTrip(s.boardId, 'cards')
    expect(result.skippedAttachments).toBe(1)
    expect(summary.counts.attachments).toBe(0)
    const water = getBoardView(t.db, summary.boardId)!.lists[0]!.cards[0]!
    expect(water.coverAttachmentId).toBeNull()
  })
})

describe('untrusted files', () => {
  async function writeZip(name: string, entries: Record<string, Uint8Array>): Promise<string> {
    const path = join(outDir, name)
    writeFileSync(path, zipSync(entries))
    return path
  }

  async function exported(): Promise<{ json: BoardFile; files: Record<string, Uint8Array> }> {
    const s = seed()
    const path = join(outDir, 'src.kanbini')
    await exportBoardFile(t.db, { userDataDir, boardId: s.boardId, content: 'cards', destPath: path })
    const files = zipEntries(path)
    return { json: JSON.parse(strFromU8(files[BOARD_FILE_JSON]!)) as BoardFile, files }
  }

  it('refuses files that are not board files', async () => {
    const notZip = join(outDir, 'notes.kanbini')
    writeFileSync(notZip, 'hello')
    await expect(readBoardFile(notZip)).rejects.toThrow("That isn't a Kanbini board file")
    const noJson = await writeZip('empty.kanbini', { 'readme.txt': strToU8('hi') })
    await expect(readBoardFile(noJson)).rejects.toThrow("That isn't a Kanbini board file")
    const other = await writeZip('other.kanbini', {
      [BOARD_FILE_JSON]: strToU8(JSON.stringify({ format: 'something-else', version: 1 }))
    })
    await expect(readBoardFile(other)).rejects.toThrow("That isn't a Kanbini board file")
  })

  it('says so when the file is from a newer Kanbini', async () => {
    const { json } = await exported()
    const path = await writeZip('newer.kanbini', {
      [BOARD_FILE_JSON]: strToU8(JSON.stringify({ ...json, version: BOARD_FILE_VERSION + 1 }))
    })
    await expect(readBoardFile(path)).rejects.toThrow('newer version of Kanbini')
  })

  it('refuses a damaged board.json', async () => {
    const { json } = await exported()
    const { cards: _cards, ...broken } = json
    const path = await writeZip('broken.kanbini', {
      [BOARD_FILE_JSON]: strToU8(JSON.stringify(broken))
    })
    await expect(readBoardFile(path)).rejects.toThrow('damaged or incomplete')
  })

  it('never writes outside the new attachment folder', async () => {
    const { json } = await exported()
    const cardId = json.cards[0]!.id
    const evil = '../../escaped.txt'
    json.attachments = [
      {
        id: 'att-evil',
        cardId,
        filename: '../escaped.txt',
        relPath: evil,
        mime: 'text/plain',
        size: 3,
        sourceUrl: null,
        sourceTitle: null,
        createdAt: 1
      }
    ]
    const path = await writeZip('evil.kanbini', {
      [BOARD_FILE_JSON]: strToU8(JSON.stringify(json)),
      [evil]: strToU8('bad')
    })
    const summary = await importBoardFile(t.db, { userDataDir, path })
    expect(existsSync(join(userDataDir, '..', 'escaped.txt'))).toBe(false)
    const row = t.db
      .select()
      .from(attachment)
      .all()
      .find((r) => r.filename.includes('escaped'))!
    expect(row.relPath).toMatch(/^attachments\/[^/]+\/escaped\.txt$/)
    expect(readFileSync(join(userDataDir, row.relPath), 'utf8')).toBe('bad')
    expect(summary.counts.attachments).toBe(1)
  })

  it('soft-narrows values this build does not know', async () => {
    const { json } = await exported()
    json.cards[0]!.priority = 'critical'
    json.lists[0]!.sortMode = 'by-mood'
    json.lists[0]!.onEnter = { kind: 'archive' }
    json.board.swimlaneMode = 'label:x'
    const path = await writeZip('future.kanbini', {
      [BOARD_FILE_JSON]: strToU8(JSON.stringify(json))
    })
    const { boardId } = await importBoardFile(t.db, { userDataDir, path })
    const view = getBoardView(t.db, boardId)!
    expect(view.board.swimlaneMode).toBeNull()
    expect(view.lists[0]).toMatchObject({ sortMode: null, onEnter: null })
  })

  it('removes the files it wrote when the database part fails', async () => {
    const s = seed()
    const { attachment: a } = await addAttachmentFromBytes(t.db, {
      userDataDir,
      cardId: s.water,
      filename: 'keep.png',
      bytes: strToU8('X')
    })
    const path = join(outDir, 'dup.kanbini')
    await exportBoardFile(t.db, { userDataDir, boardId: s.boardId, content: 'cards', destPath: path })
    const files = zipEntries(path)
    const json = JSON.parse(strFromU8(files[BOARD_FILE_JSON]!)) as BoardFile
    // Two labels with one id: the second insert fails mid-transaction.
    json.labels.push({ ...json.labels[0]!, name: 'Twin' })
    files[BOARD_FILE_JSON] = strToU8(JSON.stringify(json))
    const bad = await writeZip('dup2.kanbini', files)

    const boards = listBoards(t.db).length
    const dirs = () => readdirNames(join(userDataDir, 'attachments'))
    const before = dirs()
    await expect(importBoardFile(t.db, { userDataDir, path: bad })).rejects.toThrow()
    expect(listBoards(t.db)).toHaveLength(boards)
    expect(dirs()).toEqual(before)
    expect(before).toContain(a.relPath.split('/')[1])
  })
})

const readdirNames = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : [])

// A column added to one of these tables has to be added to the file (and
// to both directions in board-file.ts) or listed here as staying behind,
// otherwise a board loses it on the way through a file without anyone
// noticing.
describe('the file covers every column', () => {
  const shape = zBoardFile.shape
  const keys = (o: { shape: object }): string[] => Object.keys(o.shape).sort()
  const columns = (table: Parameters<typeof getTableColumns>[0], leftBehind: string[]): string[] =>
    Object.keys(getTableColumns(table))
      .filter((c) => !leftBehind.includes(c))
      .sort()

  it.each([
    // The new board gets its own id, place on the home, dates, and
    // starts unarchived and unpinned.
    ['board', board, keys(shape.board), ['id', 'projectId', 'position', 'archived', 'pinned', 'createdAt', 'updatedAt']],
    ['label', label, keys(shape.labels.element), ['boardId']],
    ['list', list, keys(shape.lists.element), ['boardId']],
    ['card', card, keys(shape.cards.element), []],
    ['card_label', cardLabel, keys(shape.cardLabels.element), []],
    ['card_dependency', cardDependency, keys(shape.cardDependencies.element), []],
    ['checklist', checklist, keys(shape.checklists.element), []],
    ['checklist_item', checklistItem, keys(shape.checklistItems.element), []],
    ['comment', comment, keys(shape.comments.element), []],
    ['attachment', attachment, keys(shape.attachments.element), []],
    ['activity', activity, keys(shape.activities.element), ['boardId']]
  ] as const)('%s', (_name, table, fileKeys, leftBehind) => {
    expect(columns(table, [...leftBehind])).toEqual(fileKeys)
  })
})
