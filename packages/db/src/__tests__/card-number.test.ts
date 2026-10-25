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

// Card numbers: a short #N per card, counted per board and never reused
// on its board (migrations 0016, 0017). Assigned by an AFTER INSERT
// trigger so every insert path gets one with no per-site code. Pinned:
//   • each board counts on its own; migration 0017 renumbers existing
//     cards per board in creation order
//   • every insert path (create, repeat spawn, templates, duplicate,
//     Trello, sample seed) gets a number unique on its board
//   • numbers are never reused, even after deleting the newest card
//   • a card keeps its number for as long as it keeps its id and its
//     board: undo / redo of a create or a repeat spawn, delete + undo;
//     a move to another board takes that board's next number, and undo
//     / redo of the move bring each number back
//   • export / import carries numbers AND each board's counter; older
//     exports are renumbered per board; bad numbers rejected
//   • a number only names a card together with its board

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

/** Every card's number grouped by board, straight from SQLite. */
const numbersByBoard = (): Map<string, Array<number | null>> => {
  const rows = t.sqlite
    .prepare(
      'SELECT l.board_id AS boardId, c.number AS number FROM card c JOIN list l ON l.id = c.list_id ORDER BY c.number'
    )
    .all() as Array<{ boardId: string; number: number | null }>
  const out = new Map<string, Array<number | null>>()
  for (const r of rows) out.set(r.boardId, [...(out.get(r.boardId) ?? []), r.number])
  return out
}

const listOf = (id: string): string =>
  (t.sqlite.prepare('SELECT list_id AS listId FROM card WHERE id = ?').get(id) as { listId: string })
    .listId

const counter = (boardId: string, on: TestDb = t): number =>
  (
    on.sqlite.prepare('SELECT card_number_last AS last FROM board WHERE id = ?').get(boardId) as {
      last: number
    }
  ).last

describe('assigning numbers', () => {
  it('counts each board on its own', () => {
    const a = board('A')
    const b = board('B')
    const one = create(a.todo, 'One')
    const two = create(b.todo, 'Two')
    const three = create(a.done, 'Three')
    expect([numberOf(one), numberOf(two), numberOf(three)]).toEqual([1, 1, 2])
    expect([counter(a.boardId), counter(b.boardId)]).toEqual([2, 1])
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

  it('gives every insert path a number unique on its board', () => {
    // The sample seed only fills an empty DB, so it goes first.
    seedSampleData(db)
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
    // Trello import.
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
    create(done, 'Last')

    const byBoard = numbersByBoard()
    // The samples', the source board, the template copy and Trello's.
    expect(byBoard.size).toBe(4)
    for (const [id, numbers] of byBoard) {
      expect(numbers).not.toContain(null)
      // Contiguous: nothing was deleted, so 1..N with no gaps.
      expect(numbers).toEqual(numbers.map((_, i) => i + 1))
      expect(counter(id)).toBe(numbers.length)
    }
  })

  it('lets two boards share a number but refuses a duplicate on one board', () => {
    const a = board('A')
    const b = board('B')
    const a1 = create(a.todo, 'A1')
    const a2 = create(a.todo, 'A2')
    const b1 = create(b.todo, 'B1')
    expect([numberOf(a1), numberOf(b1)]).toEqual([1, 1])
    const setNumber = t.sqlite.prepare('UPDATE card SET number = ? WHERE id = ?')
    expect(() => setNumber.run(1, a2)).toThrow(/already used on this board/)
    const insert = t.sqlite.prepare(
      "INSERT INTO card (id, list_id, title, position, list_added_at, number) VALUES ('dup', ?, 'Dup', 'a9', 0, 2)"
    )
    expect(() => insert.run(a.todo)).toThrow(/already used on this board/)
    // The same number on the other board is fine.
    insert.run(b.todo)
    expect(numberOf('dup')).toBe(2)
  })

  it("keeps the counter ahead when a card's list changes board without a new number", () => {
    // Only card.move changes list_id, and it renumbers; this pins the
    // triggers for any other writer.
    const a = board('A')
    const b = board('B')
    const a1 = create(a.todo, 'A1')
    create(a.todo, 'A2')
    const a3 = create(a.todo, 'A3')
    create(b.todo, 'B1')
    const moveList = t.sqlite.prepare('UPDATE card SET list_id = ? WHERE id = ?')
    expect(() => moveList.run(b.todo, a1)).toThrow(/already used on this board/)
    moveList.run(b.todo, a3)
    expect(counter(b.boardId)).toBe(3)
    expect(numberOf(create(b.todo, 'B4'))).toBe(4)
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

  it('board delete + undo keeps the board counter', () => {
    const { boardId, todo } = board()
    create(todo, 'One')
    applyMutation(db, { type: 'card.delete', id: create(todo, 'Two') })
    applyMutationRecorded(db, { type: 'board.delete', id: boardId })
    undoOne(db)
    expect(counter(boardId)).toBe(2)
    expect(numberOf(create(todo, 'Three'))).toBe(3)
  })
})

describe('moving a card to another board', () => {
  it("takes the destination board's next number; a move within a board keeps it", () => {
    const a = board('A')
    const b = board('B')
    create(a.todo, 'A1')
    const mover = create(a.todo, 'A2')
    for (const title of ['B1', 'B2', 'B3']) create(b.todo, title)
    applyMutation(db, { type: 'card.move', id: mover, toListId: a.done })
    expect(numberOf(mover)).toBe(2)
    applyMutation(db, { type: 'card.move', id: mover, toListId: b.todo })
    expect(numberOf(mover)).toBe(4)
    expect(counter(b.boardId)).toBe(4)
    // Board A's #2 stays retired.
    expect(numberOf(create(a.todo, 'A3'))).toBe(3)
  })

  it('undo gives back the old number and redo the new one', () => {
    const a = board('A')
    const b = board('B')
    const mover = create(a.todo, 'A1')
    create(b.todo, 'B1')
    create(b.todo, 'B2')
    applyMutationRecorded(db, { type: 'card.move', id: mover, toListId: b.done })
    expect(numberOf(mover)).toBe(3)
    undoOne(db)
    expect([listOf(mover), numberOf(mover)]).toEqual([a.todo, 1])
    // Board B never hands #3 out again, so redo can take it back.
    expect(numberOf(create(b.todo, 'B4'))).toBe(4)
    redoOne(db)
    expect([listOf(mover), numberOf(mover)]).toEqual([b.done, 3])
    expect(numberOf(create(a.todo, 'A2'))).toBe(2)
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

  type Row = Record<string, unknown>
  const rows = (dump: Row, table: string): Row[] => dump[table] as Row[]

  it('keeps every number and each board counter', async () => {
    const a = board('A')
    const b = board('B')
    const one = create(a.todo, 'One')
    const two = create(a.todo, 'Two')
    applyMutation(db, { type: 'card.delete', id: create(a.todo, 'Gone') })
    const bOne = create(b.todo, 'B one')
    const fresh = await roundTrip()
    try {
      expect(numberOf(one, fresh.db)).toBe(1)
      expect(numberOf(two, fresh.db)).toBe(2)
      expect(numberOf(bOne, fresh.db)).toBe(1)
      // #3 was deleted before the export; it stays retired.
      expect(counter(a.boardId, fresh)).toBe(3)
      const next = applyMutation(fresh.db, { type: 'card.create', listId: a.todo, title: 'New' }).id
      expect(numberOf(next, fresh.db)).toBe(4)
    } finally {
      fresh.close()
    }
  })

  it('renumbers an export from the one-counter days per board, in creation order', async () => {
    const a = board('A')
    const b = board('B')
    const a1 = create(a.todo, 'A first')
    const b1 = create(b.todo, 'B first')
    const a2 = create(a.todo, 'A second')
    const fresh = await roundTrip((dump) => {
      // What 0.10 wrote: format v1, numbers from one counter, no board
      // counters.
      dump['formatVersion'] = 1
      const global: Record<string, number> = { [a1]: 1, [b1]: 2, [a2]: 3 }
      for (const c of rows(dump, 'cards')) c['number'] = global[c['id'] as string]
      for (const bd of rows(dump, 'boards')) delete bd['cardNumberLast']
      dump['cardNumberSeq'] = 9
    })
    try {
      expect([numberOf(a1, fresh.db), numberOf(a2, fresh.db), numberOf(b1, fresh.db)]).toEqual([
        1, 2, 1
      ])
      expect([counter(a.boardId, fresh), counter(b.boardId, fresh)]).toEqual([2, 1])
    } finally {
      fresh.close()
    }
  })

  it('numbers an older export (no numbers) in creation order', async () => {
    const { todo } = board()
    const first = create(todo, 'First')
    const second = create(todo, 'Second')
    const fresh = await roundTrip((dump) => {
      dump['formatVersion'] = 1
      const cards = rows(dump, 'cards')
      for (const c of cards) delete c['number']
      for (const bd of rows(dump, 'boards')) delete bd['cardNumberLast']
      // Make creation order disagree with id order so the test can tell.
      cards.find((c) => c['id'] === first)!['createdAt'] = 2000
      cards.find((c) => c['id'] === second)!['createdAt'] = 1000
    })
    try {
      expect(numberOf(second, fresh.db)).toBe(1)
      expect(numberOf(first, fresh.db)).toBe(2)
    } finally {
      fresh.close()
    }
  })

  it('rejects an export with duplicate card numbers on one board', async () => {
    const { todo } = board()
    create(todo, 'One')
    create(todo, 'Two')
    await expect(
      roundTrip((dump) => {
        for (const c of rows(dump, 'cards')) c['number'] = 7
      })
    ).rejects.toThrow(/card number/i)
  })

  it('rejects an export with a malformed board counter', async () => {
    board()
    await expect(
      roundTrip((dump) => {
        for (const bd of rows(dump, 'boards')) bd['cardNumberLast'] = -1
      })
    ).rejects.toThrow(/card number counter/i)
  })

  it('writes format v2, which needs every board counter, and refuses v3', async () => {
    board('A')
    board('B')
    await expect(
      roundTrip((dump) => {
        expect(dump['formatVersion']).toBe(2)
        delete rows(dump, 'boards')[1]!['cardNumberLast']
      })
    ).rejects.toThrow(/card number counter/i)
    await expect(
      roundTrip((dump) => {
        dump['formatVersion'] = 3
      })
    ).rejects.toThrow(/format v3/)
  })
})

/** A DB built with the migrations up to and including `lastTag`. The
 *  caller plants rows, then `migrate`s it the rest of the way. */
function dbAtMigration(lastTag: string): {
  old: ReturnType<typeof openDatabase>
  full: string
  done: () => void
} {
  const upTo = migrationsUpTo(lastTag)
  const old = openDatabase({ filePath: ':memory:', migrationsFolder: upTo.folder })
  return {
    old,
    full: MIGRATIONS,
    done: () => {
      old.close()
      upTo.done()
    }
  }
}

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle')

/** A copy of the migrations with the journal cut after `lastTag`, so a
 *  test can stop a migration run part-way. */
function migrationsUpTo(lastTag: string): { folder: string; done: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), 'kanbini-mig-'))
  cpSync(MIGRATIONS, tmp, { recursive: true })
  const journalPath = join(tmp, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: Array<{ tag: string }>
  }
  journal.entries = journal.entries.slice(
    0,
    journal.entries.findIndex((e) => e.tag === lastTag) + 1
  )
  writeFileSync(journalPath, JSON.stringify(journal))
  return { folder: tmp, done: () => rmSync(tmp, { recursive: true, force: true }) }
}

describe('migration 0016', () => {
  it('numbers existing cards in creation order and starts the counter after them', () => {
    // Build a DB at migration 0015, plant cards, then apply 0016 only.
    const { old, done } = dbAtMigration('0015_card_repeat')
    const to0016 = migrationsUpTo('0016_card_number')
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

      migrate(old.db, { migrationsFolder: to0016.folder })

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
      to0016.done()
      done()
    }
  })
})

describe('migration 0017', () => {
  it('renumbers each board in creation order and starts its counter after them', () => {
    const { old, full, done } = dbAtMigration('0016_card_number')
    try {
      const s = old.sqlite
      s.prepare("INSERT INTO project (id, name) VALUES ('p', 'P')").run()
      const insBoard = s.prepare(
        "INSERT INTO board (id, project_id, name, position) VALUES (?, 'p', ?, ?)"
      )
      insBoard.run('ba', 'A', 'a0')
      insBoard.run('bb', 'B', 'a1')
      insBoard.run('be', 'Empty', 'a2')
      const insList = s.prepare("INSERT INTO list (id, board_id, name, position) VALUES (?, ?, 'L', ?)")
      insList.run('la1', 'ba', 'a0')
      insList.run('la2', 'ba', 'a1')
      insList.run('lb', 'bb', 'a0')
      const ins = s.prepare(
        "INSERT INTO card (id, list_id, title, position, list_added_at, created_at, updated_at) VALUES (?, ?, ?, 'a0', 0, ?, 0)"
      )
      // 0016 numbers these 1..5 across both boards; ids are out of
      // creation order and two of board A's cards tie on time.
      ins.run('c-z', 'la1', 'A oldest', 100)
      ins.run('c-b', 'lb', 'B oldest', 150)
      ins.run('c-m3', 'la2', 'A tie B', 200)
      ins.run('c-m2', 'la1', 'A tie A', 200)
      ins.run('c-a', 'lb', 'B newest', 300)
      // A deleted card: 0016's counter is above every number left.
      ins.run('c-gone', 'lb', 'Gone', 400)
      s.prepare("DELETE FROM card WHERE id = 'c-gone'").run()
      // Its undo entry still carries the old global number.
      s.prepare(
        "INSERT INTO undo_log (id, board_id, description, forward, inverse) VALUES ('u', 'bb', 'Delete card', '{}', '{}')"
      ).run()

      migrate(old.db, { migrationsFolder: full })

      const rows = s
        .prepare(
          'SELECT c.id, l.board_id AS board, c.number FROM card c JOIN list l ON l.id = c.list_id ORDER BY l.board_id, c.number'
        )
        .all()
      expect(rows).toEqual([
        { id: 'c-z', board: 'ba', number: 1 },
        { id: 'c-m2', board: 'ba', number: 2 },
        { id: 'c-m3', board: 'ba', number: 3 },
        { id: 'c-b', board: 'bb', number: 1 },
        { id: 'c-a', board: 'bb', number: 2 }
      ])
      expect(
        s.prepare('SELECT id, card_number_last AS last FROM board ORDER BY id').all()
      ).toEqual([
        { id: 'ba', last: 3 },
        { id: 'bb', last: 2 },
        { id: 'be', last: 0 }
      ])
      expect(
        s.prepare("SELECT name FROM sqlite_master WHERE name = 'card_number_seq'").get()
      ).toBeUndefined()
      expect(s.prepare('SELECT count(*) AS n FROM undo_log').get()).toEqual({ n: 0 })
      const insNew = s.prepare(
        "INSERT INTO card (id, list_id, title, position, list_added_at) VALUES (?, ?, 'New', 'a1', 0)"
      )
      insNew.run('c-new-b', 'lb')
      insNew.run('c-new-e', 'la2')
      const numberOfRow = (id: string): number =>
        (s.prepare('SELECT number FROM card WHERE id = ?').get(id) as { number: number }).number
      expect([numberOfRow('c-new-b'), numberOfRow('c-new-e')]).toEqual([3, 4])
    } finally {
      done()
    }
  })
})

describe('looking a card up by number', () => {
  it('getCardView takes #N or N with the board, as well as the id', () => {
    const { boardId, todo } = board()
    create(todo, 'One')
    const id = create(todo, 'Two')
    expect(getCardView(db, '#2', boardId)?.id).toBe(id)
    expect(getCardView(db, '2', boardId)?.id).toBe(id)
    // A read by id names the board too, so the number can be looked up again.
    expect([getCardView(db, id)?.number, getCardView(db, id)?.boardId]).toEqual([2, boardId])
  })

  it('finds the number on the board asked for', () => {
    const a = board('A')
    const b = board('B')
    create(a.todo, 'A1')
    const b1 = create(b.todo, 'B1')
    expect(getCardView(db, '#1', b.boardId)?.id).toBe(b1)
  })

  it('refuses a number without a board, naming the boards that have it', () => {
    const a = board('Alpha')
    const b = board('Beta')
    create(a.todo, 'A1')
    create(b.todo, 'B1')
    create(b.todo, 'B2')
    expect(() => getCardView(db, '#1')).toThrow(
      new RegExp(`per board.*"Alpha" \\(${a.boardId}\\).*"Beta" \\(${b.boardId}\\)`)
    )
    expect(() => getCardView(db, '2')).toThrow(/"Beta"/)
    expect(() => getCardView(db, '#9')).toThrow(/no board has a card #9/i)
  })

  it('returns null for a number no card on that board has', () => {
    const { boardId, todo } = board()
    create(todo, 'One')
    expect(getCardView(db, '#9', boardId)).toBeNull()
  })
})
