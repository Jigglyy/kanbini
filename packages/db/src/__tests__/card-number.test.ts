import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { zTrelloBoard } from '@kanbini/shared'
import { openDatabase, type Db } from '../client'
import { applyMutation } from '../crud'
import { getBoardView, getCardView, seedSampleData } from '../data'
import { exportToFolder } from '../export'
import { importFromFolder } from '../import'
import { importFromTrello } from '../import-trello'
import {
  instantiateBoardTemplate,
  instantiateListTemplate,
  saveBoardTemplate,
  saveListTemplate
} from '../templates'
import { applyMutationRecorded, redoOne, undoOne } from '../undo'
import { createTestDb, type TestDb } from './_setup'

// Card numbers: a global, never-reused #N per card (migration 0016).
// Assigned by an AFTER INSERT trigger so every insert path gets one with
// no per-site code. Pinned:
//   • existing cards are numbered in creation order by the migration
//   • every insert path (create, repeat spawn, templates, duplicate,
//     Trello, sample seed) gets a unique number
//   • numbers are never reused, even after deleting the newest card
//   • a card keeps its number for as long as it keeps its id: undo /
//     redo of a create or a repeat spawn, delete + undo
//   • export / import carries numbers AND the counter; older exports
//     without numbers get them in creation order; bad numbers rejected
//   • views carry the number

let t: TestDb
let db: Db

beforeEach(() => {
  t = createTestDb()
  db = t.db
})
afterEach(() => t.close())

function board(name = 'Work'): { boardId: string; todo: string; done: string } {
  const boardId = applyMutation(db, { type: 'board.create', name }).id
  const todo = applyMutation(db, { type: 'list.create', boardId, name: 'To do' }).id
  const done = applyMutation(db, { type: 'list.create', boardId, name: 'Done' }).id
  return { boardId, todo, done }
}

const create = (listId: string, title: string): string =>
  applyMutation(db, { type: 'card.create', listId, title }).id

const numberOf = (id: string, on: Db = db): number | undefined =>
  getCardView(on, id)?.number

/** Every card row's number, straight from SQLite. */
const allNumbers = (): Array<number | null> =>
  (t.sqlite.prepare('SELECT number FROM card ORDER BY number').all() as Array<{
    number: number | null
  }>).map((r) => r.number)

const counter = (): number =>
  (t.sqlite.prepare('SELECT last FROM card_number_seq WHERE id = 1').get() as { last: number })
    .last

describe('assigning numbers', () => {
  it('numbers new cards 1, 2, 3 across every board', () => {
    const a = board('A')
    const b = board('B')
    const one = create(a.todo, 'One')
    const two = create(b.todo, 'Two')
    const three = create(a.done, 'Three')
    expect([numberOf(one), numberOf(two), numberOf(three)]).toEqual([1, 2, 3])
  })

  it('carries the number in the board view and the card view', () => {
    const { boardId, todo } = board()
    const id = create(todo, 'One')
    const fromBoard = getBoardView(db, boardId)!.lists[0]!.cards[0]!
    expect(fromBoard.number).toBe(1)
    expect(getCardView(db, id)!.number).toBe(1)
  })

  it('never reuses a number, even after deleting the newest card', () => {
    const { todo } = board()
    create(todo, 'One')
    const two = create(todo, 'Two')
    applyMutation(db, { type: 'card.delete', id: two })
    const next = create(todo, 'Three')
    expect(numberOf(next)).toBe(3)
  })

  it('gives every insert path a unique number', () => {
    const { boardId, todo, done } = board()
    create(todo, 'Plain')
    // Repeat spawn (recorded path is the one that spawns).
    const rep = create(todo, 'Water plants')
    applyMutation(db, {
      type: 'card.update',
      id: rep,
      patch: { repeat: { unit: 'week', every: 1 } }
    })
    applyMutationRecorded(db, { type: 'card.update', id: rep, patch: { completed: true } })
    // Board + list templates, and board.duplicate.
    const boardTpl = saveBoardTemplate(db, boardId, 'Tpl')
    instantiateBoardTemplate(db, boardTpl.id)
    const listTpl = saveListTemplate(db, todo, 'List tpl')
    instantiateListTemplate(db, listTpl.id, boardId)
    applyMutation(db, { type: 'board.duplicate', id: boardId })
    // Trello import + the sample seed.
    importFromTrello(
      db,
      zTrelloBoard.parse({
        id: 'trello-1',
        name: 'From Trello',
        lists: [{ id: 'L-1', name: 'Todo', pos: 1 }],
        labels: [],
        cards: [
          { id: 'C-1', name: 'Imported', desc: '', idList: 'L-1', idLabels: [], pos: 1 }
        ],
        checklists: []
      })
    )
    seedSampleData(db)
    create(done, 'Last')

    const numbers = allNumbers()
    expect(numbers.length).toBeGreaterThan(10)
    expect(numbers).not.toContain(null)
    expect(new Set(numbers).size).toBe(numbers.length)
    // Contiguous: nothing was deleted, so 1..N with no gaps.
    expect(numbers).toEqual(numbers.map((_, i) => i + 1))
    expect(counter()).toBe(numbers.length)
  })
})

describe('a card keeps its number while it keeps its id', () => {
  it('undo + redo of a create brings back the same number', () => {
    const { boardId, todo } = board()
    create(todo, 'Before')
    const id = applyMutationRecorded(db, { type: 'card.create', listId: todo, title: 'Mine' }).id
    expect(numberOf(id)).toBe(2)
    undoOne(db, boardId)
    expect(getCardView(db, id)).toBeNull()
    // Something else is created while it's gone - it must not take #2.
    const other = create(todo, 'Interloper')
    expect(numberOf(other)).toBe(3)
    redoOne(db, boardId)
    expect(numberOf(id)).toBe(2)
  })

  it('delete + undo restores the number', () => {
    const { boardId, todo } = board()
    create(todo, 'One')
    const id = create(todo, 'Two')
    applyMutationRecorded(db, { type: 'card.delete', id })
    undoOne(db, boardId)
    expect(numberOf(id)).toBe(2)
    expect(numberOf(create(todo, 'Three'))).toBe(3)
  })

  it('undo + redo of a repeat spawn keeps the copy number', () => {
    const { boardId, todo } = board()
    const id = create(todo, 'Water plants')
    applyMutation(db, {
      type: 'card.update',
      id,
      patch: { repeat: { unit: 'week', every: 1 } }
    })
    applyMutationRecorded(db, { type: 'card.update', id, patch: { completed: true } })
    const copy = getBoardView(db, boardId)!.lists[0]!.cards.find((c) => c.id !== id)!
    expect(copy.number).toBe(2)

    undoOne(db, boardId)
    expect(getCardView(db, copy.id)).toBeNull()
    redoOne(db, boardId)
    expect(numberOf(copy.id)).toBe(2)
  })
})

describe('export / import', () => {
  async function roundTrip(
    tweak?: (dump: Record<string, unknown>) => void
  ): Promise<TestDb> {
    const ud = mkdtempSync(join(tmpdir(), 'kanbini-number-'))
    try {
      await exportToFolder(db, ud, join(ud, 'export'))
      if (tweak) {
        const p = join(ud, 'export', 'kanbini.json')
        const dump = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
        tweak(dump)
        writeFileSync(p, JSON.stringify(dump))
      }
      const fresh = createTestDb()
      try {
        await importFromFolder(fresh.db, ud, join(ud, 'export'))
      } catch (e) {
        fresh.close()
        throw e
      }
      return fresh
    } finally {
      rmSync(ud, { recursive: true, force: true })
    }
  }

  it('keeps every number and the counter', async () => {
    const { todo } = board()
    const one = create(todo, 'One')
    const two = create(todo, 'Two')
    applyMutation(db, { type: 'card.delete', id: create(todo, 'Gone') })
    const fresh = await roundTrip()
    try {
      expect(numberOf(one, fresh.db)).toBe(1)
      expect(numberOf(two, fresh.db)).toBe(2)
      // #3 was deleted before the export; it stays retired.
      const list = getBoardView(fresh.db)!.lists[0]!.id
      const next = applyMutation(fresh.db, { type: 'card.create', listId: list, title: 'New' }).id
      expect(numberOf(next, fresh.db)).toBe(4)
    } finally {
      fresh.close()
    }
  })

  it('numbers an older export (no numbers) in creation order', async () => {
    const { todo } = board()
    const first = create(todo, 'First')
    const second = create(todo, 'Second')
    const fresh = await roundTrip((dump) => {
      const cards = dump['cards'] as Array<Record<string, unknown>>
      for (const c of cards) delete c['number']
      // Make creation order disagree with id order so the test can tell.
      cards.find((c) => c['id'] === first)!['createdAt'] = 2000
      cards.find((c) => c['id'] === second)!['createdAt'] = 1000
      delete dump['cardNumberSeq']
    })
    try {
      expect(numberOf(second, fresh.db)).toBe(1)
      expect(numberOf(first, fresh.db)).toBe(2)
    } finally {
      fresh.close()
    }
  })

  it('rejects an export with duplicate card numbers', async () => {
    const { todo } = board()
    create(todo, 'One')
    create(todo, 'Two')
    await expect(
      roundTrip((dump) => {
        for (const c of dump['cards'] as Array<Record<string, unknown>>) c['number'] = 7
      })
    ).rejects.toThrow(/card number/i)
  })
})

describe('migration 0016', () => {
  it('numbers existing cards in creation order and starts the counter after them', () => {
    // Build a DB at migration 0015, plant cards, then apply the rest.
    const here = dirname(fileURLToPath(import.meta.url))
    const full = resolve(here, '../../drizzle')
    const tmp = mkdtempSync(join(tmpdir(), 'kanbini-mig-'))
    try {
      cpSync(full, tmp, { recursive: true })
      const journalPath = join(tmp, 'meta', '_journal.json')
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
        entries: Array<{ tag: string }>
      }
      const upTo = journal.entries.findIndex((e) => e.tag === '0015_card_repeat')
      journal.entries = journal.entries.slice(0, upTo + 1)
      writeFileSync(journalPath, JSON.stringify(journal))

      const old = openDatabase({ filePath: ':memory:', migrationsFolder: tmp })
      try {
        const s = old.sqlite
        s.prepare("INSERT INTO project (id, name) VALUES ('p', 'P')").run()
        s.prepare(
          "INSERT INTO board (id, project_id, name, position) VALUES ('b', 'p', 'B', 'a0')"
        ).run()
        s.prepare(
          "INSERT INTO list (id, board_id, name, position) VALUES ('l', 'b', 'L', 'a0')"
        ).run()
        const ins = s.prepare(
          "INSERT INTO card (id, list_id, title, position, list_added_at, created_at, updated_at) VALUES (?, 'l', ?, 'a0', 0, ?, 0)"
        )
        // ids deliberately out of creation order; c2 and c3 tie on time.
        ins.run('c-z', 'Oldest', 100)
        ins.run('c-a', 'Newest', 300)
        ins.run('c-m3', 'Tie B', 200)
        ins.run('c-m2', 'Tie A', 200)

        migrate(old.db, { migrationsFolder: full })

        const rows = s.prepare('SELECT id, number FROM card ORDER BY number').all()
        expect(rows).toEqual([
          { id: 'c-z', number: 1 },
          { id: 'c-m2', number: 2 },
          { id: 'c-m3', number: 3 },
          { id: 'c-a', number: 4 }
        ])
        expect(
          (s.prepare('SELECT last FROM card_number_seq WHERE id = 1').get() as { last: number })
            .last
        ).toBe(4)
        s.prepare(
          "INSERT INTO card (id, list_id, title, position, list_added_at) VALUES ('c-new', 'l', 'New', 'a1', 0)"
        ).run()
        expect(
          (s.prepare("SELECT number FROM card WHERE id = 'c-new'").get() as { number: number })
            .number
        ).toBe(5)
      } finally {
        old.close()
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('looking a card up by number', () => {
  it('getCardView accepts #N or N as well as the id', () => {
    const { todo } = board()
    create(todo, 'One')
    const id = create(todo, 'Two')
    expect(getCardView(db, '#2')?.id).toBe(id)
    expect(getCardView(db, '2')?.id).toBe(id)
    expect(getCardView(db, id)?.number).toBe(2)
  })

  it('returns null for a number no card has', () => {
    const { todo } = board()
    create(todo, 'One')
    expect(getCardView(db, '#9')).toBeNull()
  })
})
