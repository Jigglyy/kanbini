import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { type ListSortMode, newId, orderKeysBetween } from '@kanbini/shared'
import { applyMutation, ensureDefaultProjectId } from '../crud'
import { getBoardView } from '../data'
import { applyMutationRecorded, undoOne } from '../undo'
import type { Db } from '../client'
import { card } from '../schema'
import { createTestDb } from './_setup'

// Read-side ordering for every list sort mode (ADR-0032 + follow-up).
// Four cards are inserted with hand-picked createdAt / listAddedAt /
// dueAt / priority / title so each mode yields a distinct, deterministic
// id order. The titles deliberately mix case (apple / Banana / Cherry /
// date) so the alphabetical modes prove they are case-insensitive
// (lower()), not a raw binary sort. The headless MCP reader is checked
// for parity against this same ordering in apps/mcp's headless.test.ts.

let db: Db
let close: () => void

beforeEach(() => {
  const t = createTestDb()
  db = t.db
  close = t.close
})
afterEach(() => close())

/** Seed a board + list with four fully-controlled cards. Returns the
 *   list id and a key->id map so expectations read as letters. */
function setup(): { listId: string; id: Record<string, string> } {
  const projectId = ensureDefaultProjectId(db)
  const board = applyMutation(db, { type: 'board.create', projectId, name: 'B' })
  const list = applyMutation(db, {
    type: 'list.create',
    boardId: board.id,
    name: 'L'
  })
  const keys = orderKeysBetween(null, null, 4)
  const rows = [
    { key: 'A', createdAt: 100, listAddedAt: 400, dueAt: 3000, priority: 'low', title: 'Banana' },
    { key: 'B', createdAt: 200, listAddedAt: 300, dueAt: 1000, priority: 'urgent', title: 'apple' },
    { key: 'C', createdAt: 300, listAddedAt: 200, dueAt: null, priority: 'high', title: 'Cherry' },
    { key: 'D', createdAt: 400, listAddedAt: 100, dueAt: 2000, priority: null, title: 'date' }
  ]
  const id: Record<string, string> = {}
  rows.forEach((r, i) => {
    const cardId = newId()
    id[r.key] = cardId
    db.insert(card)
      .values({
        id: cardId,
        listId: list.id,
        title: r.title,
        position: keys[i]!,
        dueAt: r.dueAt,
        priority: r.priority,
        createdAt: r.createdAt,
        listAddedAt: r.listAddedAt,
        updatedAt: r.createdAt
      })
      .run()
  })
  return { listId: list.id, id }
}

function orderOf(listId: string): string[] {
  const view = getBoardView(db)!
  return view.lists.find((l) => l.id === listId)!.cards.map((c) => c.id)
}

describe('list sort modes (getBoardView ordering)', () => {
  const cases: Array<[ListSortMode | null, string[]]> = [
    [null, ['A', 'B', 'C', 'D']], // manual = fractional position
    ['created-desc', ['D', 'C', 'B', 'A']],
    ['created-asc', ['A', 'B', 'C', 'D']],
    ['added-desc', ['A', 'B', 'C', 'D']], // listAddedAt: A400 B300 C200 D100
    ['added-asc', ['D', 'C', 'B', 'A']],
    ['due-asc', ['B', 'D', 'A', 'C']], // B1000 D2000 A3000, C(null) last
    ['title-asc', ['B', 'A', 'C', 'D']], // apple Banana Cherry date
    ['title-desc', ['D', 'C', 'A', 'B']],
    ['priority-desc', ['B', 'C', 'A', 'D']] // urgent high low unprioritised
  ]

  for (const [mode, expected] of cases) {
    it(`orders by ${mode ?? 'manual'}`, () => {
      const { listId, id } = setup()
      if (mode) {
        applyMutation(db, {
          type: 'list.update',
          id: listId,
          patch: { sortMode: mode }
        })
      }
      expect(orderOf(listId)).toEqual(expected.map((k) => id[k]))
    })
  }

  it('flipping a sorted list back to manual freezes the displayed order', () => {
    const { listId, id } = setup()
    // Sort by priority, then go back to manual: the fresh fractional
    // positions must encode the priority order (B, C, A, D), not the
    // original insert order.
    applyMutation(db, {
      type: 'list.update',
      id: listId,
      patch: { sortMode: 'priority-desc' }
    })
    applyMutation(db, {
      type: 'list.update',
      id: listId,
      patch: { sortMode: null }
    })
    expect(orderOf(listId)).toEqual(['B', 'C', 'A', 'D'].map((k) => id[k]))
  })
})

describe('listAddedAt stamping (ADR-0032 follow-up)', () => {
  const addedAt = (cardId: string): number =>
    db
      .select({ v: card.listAddedAt })
      .from(card)
      .where(eq(card.id, cardId))
      .get()!.v

  it('cross-list move re-stamps listAddedAt; undo restores the prior value', () => {
    const projectId = ensureDefaultProjectId(db)
    const board = applyMutationRecorded(db, {
      type: 'board.create',
      projectId,
      name: 'B'
    })
    const l1 = applyMutationRecorded(db, {
      type: 'list.create',
      boardId: board.id,
      name: 'L1'
    })
    const l2 = applyMutationRecorded(db, {
      type: 'list.create',
      boardId: board.id,
      name: 'L2'
    })
    const c = applyMutationRecorded(db, {
      type: 'card.create',
      listId: l1.id,
      title: 'X'
    })

    // Pin a known entry time so the re-stamp and the restore are visible
    // even when everything happens within one millisecond.
    db.update(card).set({ listAddedAt: 11111 }).where(eq(card.id, c.id)).run()
    expect(addedAt(c.id)).toBe(11111)

    applyMutationRecorded(db, {
      type: 'card.move',
      id: c.id,
      toListId: l2.id,
      beforeId: null,
      afterId: null
    })
    // The cross-list arrival stamped a fresh (now) time.
    expect(addedAt(c.id)).not.toBe(11111)

    expect(undoOne(db).applied).toBe(true)
    // Undo put the card back in L1 AND restored its prior entry time.
    expect(addedAt(c.id)).toBe(11111)
  })

  it('an in-list reorder leaves listAddedAt untouched', () => {
    const projectId = ensureDefaultProjectId(db)
    const board = applyMutationRecorded(db, {
      type: 'board.create',
      projectId,
      name: 'B'
    })
    const l1 = applyMutationRecorded(db, {
      type: 'list.create',
      boardId: board.id,
      name: 'L1'
    })
    const a = applyMutationRecorded(db, {
      type: 'card.create',
      listId: l1.id,
      title: 'A'
    })
    const b = applyMutationRecorded(db, {
      type: 'card.create',
      listId: l1.id,
      title: 'B'
    })
    db.update(card).set({ listAddedAt: 22222 }).where(eq(card.id, a.id)).run()

    // Move A after B within the same list - not a list change.
    applyMutationRecorded(db, {
      type: 'card.move',
      id: a.id,
      toListId: l1.id,
      beforeId: b.id,
      afterId: null
    })
    expect(addedAt(a.id)).toBe(22222)
  })
})
