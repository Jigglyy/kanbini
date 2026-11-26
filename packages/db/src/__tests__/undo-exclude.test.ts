import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { boardsChangedBy } from '../changed-boards'
import { ensureDefaultProjectId } from '../crud'
import { getBoardView } from '../data'
import { type Db } from '../client'
import { undoLog } from '../schema'
import {
  applyMutationRecorded,
  applyMutationsRecorded,
  clearUndoLog,
  redoOne,
  undoOne
} from '../undo'
import { createTestDb } from './_setup'

// Undo / redo with `lockedBoardIds` (boards the renderer has locked
// read-only, ADR-0089). With no scope (home), entries logged under a
// locked board are skipped, and so is any group with a row logged under
// one, whole. Scoped or not, an entry that would CHANGE a locked board
// (a cross-board move, copy or link, a group spanning boards) is refused:
// nothing applies, the entry stays, and the result names the board.

let db: Db
let close: () => void
let projectId: string

beforeEach(() => {
  const t = createTestDb()
  db = t.db
  close = t.close
  projectId = ensureDefaultProjectId(db)
})

afterEach(() => close())

function seed(name: string): { boardId: string; listId: string; cards: string[] } {
  const b = applyMutationRecorded(db, { type: 'board.create', projectId, name })
  const l = applyMutationRecorded(db, { type: 'list.create', boardId: b.id, name: 'L' })
  const cards = ['T1', 'T2'].map(
    (title) => applyMutationRecorded(db, { type: 'card.create', listId: l.id, title }).id
  )
  return { boardId: b.id, listId: l.id, cards }
}

const titles = (boardId: string): string[] =>
  getBoardView(db, boardId)!.lists[0]!.cards.map((c) => c.title)

const rename = (id: string, title: string) =>
  ({ type: 'card.update', id, patch: { title } }) as const

const statusOf = (count: 'undoable' | 'undone'): number =>
  db.select().from(undoLog).where(eq(undoLog.status, count)).all().length

let a: ReturnType<typeof seed>
let b: ReturnType<typeof seed>
beforeEach(() => {
  a = seed('A')
  b = seed('B')
  clearUndoLog(db)
})

describe('no scope (home): a locked board\'s own entries are skipped', () => {
  it('undo skips the newest entry on a locked board and takes the next one', () => {
    applyMutationRecorded(db, rename(b.cards[0]!, 'B-edit'))
    applyMutationRecorded(db, rename(a.cards[0]!, 'A-edit'))
    const r = undoOne(db, null, [a.boardId])
    expect(r).toEqual({ applied: true, boardId: b.boardId })
    expect(titles(a.boardId)).toContain('A-edit')
    expect(titles(b.boardId)).toContain('T1')
    // Nothing else is eligible: A's entry stays put.
    expect(undoOne(db, null, [a.boardId]).applied).toBe(false)
    expect(titles(a.boardId)).toContain('A-edit')
  })

  it('undo skips a group with any row on a locked board, whole', () => {
    applyMutationRecorded(db, rename(b.cards[0]!, 'B-old'))
    // A group spanning both boards (an AI batch can): neither half goes.
    applyMutationsRecorded(db, [rename(a.cards[0]!, 'A-grp'), rename(b.cards[1]!, 'B-grp')])
    const r = undoOne(db, null, [a.boardId])
    expect(r.applied).toBe(true)
    expect(titles(b.boardId)).toEqual(['T1', 'B-grp'])
    expect(titles(a.boardId)).toContain('A-grp')
    // Without the lock the group undoes whole.
    expect(undoOne(db).applied).toBe(true)
    expect(titles(a.boardId)).toEqual(['T1', 'T2'])
    expect(titles(b.boardId)).toEqual(['T1', 'T2'])
  })

  it('redo skips a locked board and a group touching it the same way', () => {
    applyMutationRecorded(db, rename(a.cards[0]!, 'A-edit'))
    applyMutationsRecorded(db, [rename(a.cards[1]!, 'A-grp'), rename(b.cards[1]!, 'B-grp')])
    applyMutationRecorded(db, rename(b.cards[0]!, 'B-edit'))
    // Undo all three (no lock), then redo with A locked.
    for (let i = 0; i < 3; i++) expect(undoOne(db).applied).toBe(true)
    const r = redoOne(db, null, [a.boardId])
    expect(r).toEqual({ applied: true, boardId: b.boardId })
    expect(titles(b.boardId)).toEqual(['B-edit', 'T2'])
    expect(titles(a.boardId)).toEqual(['T1', 'T2'])
    expect(redoOne(db, null, [a.boardId]).applied).toBe(false)
  })
})

describe('an undo / redo that would change a locked board is refused', () => {
  it('undoing a card moved onto a locked board, from the board it came from', () => {
    applyMutationRecorded(db, { type: 'card.move', id: a.cards[0]!, toListId: b.listId })
    expect(titles(b.boardId)).toContain('T1')
    const r = undoOne(db, a.boardId, [b.boardId])
    expect(r).toEqual({ applied: false, boardId: null, lockedBoardId: b.boardId })
    // Nothing moved and the entry is still there to undo once unlocked.
    expect(titles(b.boardId)).toContain('T1')
    expect(statusOf('undoable')).toBe(1)
    expect(undoOne(db, a.boardId).applied).toBe(true)
    expect(titles(a.boardId)).toEqual(['T1', 'T2'])
  })

  it('the same from home', () => {
    applyMutationRecorded(db, { type: 'card.move', id: a.cards[0]!, toListId: b.listId })
    expect(undoOne(db, null, [b.boardId])).toMatchObject({
      applied: false,
      lockedBoardId: b.boardId
    })
  })

  it('undoing a copy onto a locked board', () => {
    applyMutationRecorded(db, { type: 'card.copy', id: a.cards[0]!, toListId: b.listId })
    expect(titles(b.boardId)).toHaveLength(3)
    expect(undoOne(db, a.boardId, [b.boardId]).lockedBoardId).toBe(b.boardId)
    expect(titles(b.boardId)).toHaveLength(3)
  })

  it('undoing a "waiting on" link to a card on a locked board', () => {
    applyMutationRecorded(db, {
      type: 'card.addBlocker',
      id: a.cards[0]!,
      blockerId: b.cards[0]!
    })
    expect(undoOne(db, a.boardId, [b.boardId]).lockedBoardId).toBe(b.boardId)
    expect(getBoardView(db, a.boardId)!.lists[0]!.cards[0]!.blockedBy).toHaveLength(1)
  })

  it('a scoped undo of a group that spans a locked board', () => {
    applyMutationsRecorded(db, [rename(a.cards[0]!, 'A-grp'), rename(b.cards[0]!, 'B-grp')])
    expect(undoOne(db, a.boardId, [b.boardId]).lockedBoardId).toBe(b.boardId)
    // Rolled back whole: A's half was not undone either.
    expect(titles(a.boardId)).toContain('A-grp')
    expect(titles(b.boardId)).toContain('B-grp')
  })

  it('redoing a move onto a locked board', () => {
    applyMutationRecorded(db, { type: 'card.move', id: a.cards[0]!, toListId: b.listId })
    expect(undoOne(db, a.boardId).applied).toBe(true)
    expect(redoOne(db, a.boardId, [b.boardId]).lockedBoardId).toBe(b.boardId)
    expect(titles(a.boardId)).toContain('T1')
    expect(statusOf('undone')).toBe(1)
  })

  it('an undo that only touches unlocked boards still runs', () => {
    applyMutationRecorded(db, rename(a.cards[0]!, 'A-edit'))
    expect(undoOne(db, a.boardId, [b.boardId])).toEqual({ applied: true, boardId: a.boardId })
  })
})

describe('boardsChangedBy', () => {
  it('names the boards a write would change', () => {
    expect(boardsChangedBy(db, rename(a.cards[0]!, 'x'))).toEqual([a.boardId])
    expect(
      boardsChangedBy(db, { type: 'card.move', id: a.cards[0]!, toListId: b.listId }).sort()
    ).toEqual([a.boardId, b.boardId].sort())
    expect(boardsChangedBy(db, { type: 'card.copy', id: a.cards[0]!, toListId: b.listId })).toEqual(
      [b.boardId]
    )
    expect(boardsChangedBy(db, { type: 'label.create', boardId: b.boardId, name: 'L', color: 'red' }))
      .toEqual([b.boardId])
  })

  it('ticks, view settings and arranging the home screen change nothing', () => {
    const card = a.cards[0]!
    expect(boardsChangedBy(db, { type: 'card.update', id: card, patch: { completed: true } })).toEqual([])
    expect(boardsChangedBy(db, { type: 'card.update', id: card, patch: { collapsed: true } })).toEqual([])
    expect(
      boardsChangedBy(db, { type: 'list.update', id: a.listId, patch: { visibleCardLimit: 10 } })
    ).toEqual([])
    expect(
      boardsChangedBy(db, { type: 'board.update', id: a.boardId, patch: { swimlaneMode: 'priority' } })
    ).toEqual([])
    expect(boardsChangedBy(db, { type: 'board.move', id: a.boardId, beforeId: null, afterId: null }))
      .toEqual([])
    expect(boardsChangedBy(db, { type: 'board.duplicate', id: a.boardId })).toEqual([])
  })
})
