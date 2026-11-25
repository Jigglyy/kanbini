import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureDefaultProjectId } from '../crud'
import { getBoardView } from '../data'
import { type Db } from '../client'
import {
  applyMutationRecorded,
  applyMutationsRecorded,
  clearUndoLog,
  redoOne,
  undoOne
} from '../undo'
import { createTestDb } from './_setup'

// `excludeBoardIds` (boards the renderer has locked read-only): entries
// logged under an excluded board are skipped, and so is any group with a
// row logged under one, whole; the next eligible entry is taken instead.

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

function seed(name: string): { boardId: string; cards: string[] } {
  const b = applyMutationRecorded(db, { type: 'board.create', projectId, name })
  const l = applyMutationRecorded(db, { type: 'list.create', boardId: b.id, name: 'L' })
  const cards = ['T1', 'T2'].map(
    (title) => applyMutationRecorded(db, { type: 'card.create', listId: l.id, title }).id
  )
  return { boardId: b.id, cards }
}

const titles = (boardId: string): string[] =>
  getBoardView(db, boardId)!.lists[0]!.cards.map((c) => c.title)

const rename = (id: string, title: string) =>
  ({ type: 'card.update', id, patch: { title } }) as const

describe('undoOne / redoOne with excludeBoardIds', () => {
  let a: ReturnType<typeof seed>
  let b: ReturnType<typeof seed>
  beforeEach(() => {
    a = seed('A')
    b = seed('B')
    clearUndoLog(db)
  })

  it('undo skips the newest entry on an excluded board and takes the next one', () => {
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

  it('undo skips a group with any row on an excluded board, whole', () => {
    applyMutationRecorded(db, rename(b.cards[0]!, 'B-old'))
    // A group spanning both boards (an AI batch can): neither half goes.
    applyMutationsRecorded(db, [rename(a.cards[0]!, 'A-grp'), rename(b.cards[1]!, 'B-grp')])
    const r = undoOne(db, null, [a.boardId])
    expect(r.applied).toBe(true)
    expect(titles(b.boardId)).toEqual(['T1', 'B-grp'])
    expect(titles(a.boardId)).toContain('A-grp')
    // Without the exclusion the group undoes whole.
    expect(undoOne(db).applied).toBe(true)
    expect(titles(a.boardId)).toEqual(['T1', 'T2'])
    expect(titles(b.boardId)).toEqual(['T1', 'T2'])
  })

  it('redo skips an excluded board and an excluded group the same way', () => {
    applyMutationRecorded(db, rename(a.cards[0]!, 'A-edit'))
    applyMutationsRecorded(db, [rename(a.cards[1]!, 'A-grp'), rename(b.cards[1]!, 'B-grp')])
    applyMutationRecorded(db, rename(b.cards[0]!, 'B-edit'))
    // Undo all three (no exclusion), then redo with A excluded.
    for (let i = 0; i < 3; i++) expect(undoOne(db).applied).toBe(true)
    const r = redoOne(db, null, [a.boardId])
    expect(r).toEqual({ applied: true, boardId: b.boardId })
    expect(titles(b.boardId)).toEqual(['B-edit', 'T2'])
    expect(titles(a.boardId)).toEqual(['T1', 'T2'])
    expect(redoOne(db, null, [a.boardId]).applied).toBe(false)
  })
})
