import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { desc, eq } from 'drizzle-orm'
import { isInternalMutation, type Mutation } from '@kanbini/shared'
import { applyMutation, ensureDefaultProjectId } from '../crud'
import { getCardView } from '../data'
import { applyMutationRecorded, redoOne, undoOne } from '../undo'
import type { Db } from '../client'
import { card, undoLog } from '../schema'
import { createTestDb } from './_setup'

// Undo of a move into (or out of) a list with an on-enter rule (ADR-0041).
// The rule flips the card's completion inside the move, and the undo used
// to put the card back without flipping it back: two Ctrl+Z steps, or a
// wrong state when the list it returned to has a rule of its own.

let db: Db
let close: () => void

beforeEach(() => {
  const t = createTestDb()
  db = t.db
  close = t.close
})
afterEach(() => close())

function setup() {
  const projectId = ensureDefaultProjectId(db)
  const boardId = applyMutation(db, { type: 'board.create', projectId, name: 'B' }).id
  const list = (name: string, rule?: 'complete' | 'uncomplete') => {
    const id = applyMutation(db, { type: 'list.create', boardId, name }).id
    if (rule) applyMutation(db, { type: 'list.update', id, patch: { onEnter: { kind: rule } } })
    return id
  }
  const todo = list('Todo', 'uncomplete')
  const plain = list('Someday')
  const done = list('Done', 'complete')
  const card = applyMutation(db, { type: 'card.create', listId: todo, title: 'Pay rent' }).id
  return { boardId, todo, plain, done, card }
}

const completed = (id: string) => getCardView(db, id)!.completed
const listIdOf = (id: string) =>
  db.select({ l: card.listId }).from(card).where(eq(card.id, id)).get()!.l

describe('undo of a move through an on-enter rule', () => {
  it('one Ctrl+Z puts the card back AND reopens it', () => {
    const s = setup()
    applyMutationRecorded(db, { type: 'card.move', id: s.card, toListId: s.done })
    expect(completed(s.card)).toBe(true)
    expect(undoOne(db, s.boardId).applied).toBe(true)
    expect(listIdOf(s.card)).toBe(s.todo)
    expect(completed(s.card)).toBe(false)
  })

  it("restores the earlier state even when the list it returns to has its own rule", () => {
    const s = setup()
    // Ticked by hand while in Todo (Todo's rule only fires on entry).
    applyMutationRecorded(db, { type: 'card.update', id: s.card, patch: { completed: true } })
    applyMutationRecorded(db, { type: 'card.move', id: s.card, toListId: s.done })
    // Back into Todo would fire "uncomplete on entry"; the undo overrides it.
    undoOne(db, s.boardId)
    expect(listIdOf(s.card)).toBe(s.todo)
    expect(completed(s.card)).toBe(true)
  })

  it('redo fires the rule again', () => {
    const s = setup()
    applyMutationRecorded(db, { type: 'card.move', id: s.card, toListId: s.done })
    undoOne(db, s.boardId)
    expect(redoOne(db, s.boardId).applied).toBe(true)
    expect(listIdOf(s.card)).toBe(s.done)
    expect(completed(s.card)).toBe(true)
  })

  it('logs the reopening in the card feed', () => {
    const s = setup()
    // From a list without a rule, so only the undo reopens it.
    applyMutation(db, { type: 'card.move', id: s.card, toListId: s.plain })
    applyMutationRecorded(db, { type: 'card.move', id: s.card, toListId: s.done })
    undoOne(db, s.boardId)
    expect(getCardView(db, s.card)!.activities[0]!.type).toBe('reopened')
  })

  it('a move between lists without rules records no completion', () => {
    const s = setup()
    const other = applyMutation(db, { type: 'list.create', boardId: s.boardId, name: 'Other' }).id
    applyMutation(db, { type: 'card.move', id: s.card, toListId: s.plain })
    applyMutationRecorded(db, { type: 'card.move', id: s.card, toListId: other })
    const inverse = db.select().from(undoLog).orderBy(desc(undoLog.id)).get()!.inverse as Mutation
    expect(inverse.type === 'card.move' && inverse.completed).toBeUndefined()
  })

  it('is undo-only: external callers may not set it', () => {
    expect(isInternalMutation({ type: 'card.move', id: 'c', toListId: 'l', completed: true })).toBe(
      true
    )
  })
})

