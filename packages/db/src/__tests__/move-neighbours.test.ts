import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { applyMutation, ensureDefaultProjectId } from '../crud'
import { getBoardView } from '../data'
import type { Db } from '../client'
import { card } from '../schema'
import { createTestDb } from './_setup'

// card.move with only one neighbour, or none. The renderer always names
// both, but MCP / HTTP callers usually don't: an AI moving a card to
// "Done" passes no position at all, and one placing a card "under X"
// passes only that card. Both used to go straight to orderKeyBetween
// with a missing side, which mints a key that can equal an existing
// card's (no neighbours at all minted the same key every time), so
// moved cards landed in an arbitrary order instead of where asked.

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
  const board = applyMutation(db, { type: 'board.create', projectId, name: 'B' })
  const src = applyMutation(db, { type: 'list.create', boardId: board.id, name: 'Src' }).id
  const dst = applyMutation(db, { type: 'list.create', boardId: board.id, name: 'Dst' }).id
  const id: Record<string, string> = {}
  for (const t of ['A', 'B', 'C']) {
    id[t] = applyMutation(db, { type: 'card.create', listId: src, title: t }).id
  }
  for (const t of ['X', 'Y', 'Z']) {
    id[t] = applyMutation(db, { type: 'card.create', listId: dst, title: t }).id
  }
  return { src, dst, id }
}

function titles(listId: string): string[] {
  const view = getBoardView(db)!
  return view.lists.find((l) => l.id === listId)!.cards.map((c) => c.title)
}

describe('card.move with missing neighbours', () => {
  it('no neighbours appends each moved card to the end, in call order', () => {
    const { dst, id } = setup()
    for (const t of ['A', 'C', 'B']) {
      applyMutation(db, { type: 'card.move', id: id[t]!, toListId: dst })
    }
    expect(titles(dst)).toEqual(['X', 'Y', 'Z', 'A', 'C', 'B'])
  })

  it('no neighbours into an empty list keeps call order', () => {
    const { id } = setup()
    const board = getBoardView(db)!
    const empty = applyMutation(db, { type: 'list.create', boardId: board.board.id, name: 'Empty' }).id
    for (const t of ['B', 'A', 'C']) {
      applyMutation(db, { type: 'card.move', id: id[t]!, toListId: empty })
    }
    expect(titles(empty)).toEqual(['B', 'A', 'C'])
  })

  it('only beforeId puts the card directly below that card', () => {
    const { dst, id } = setup()
    applyMutation(db, { type: 'card.move', id: id['A']!, toListId: dst, beforeId: id['X']! })
    expect(titles(dst)).toEqual(['X', 'A', 'Y', 'Z'])
  })

  it('only afterId puts the card directly above that card', () => {
    const { dst, id } = setup()
    applyMutation(db, { type: 'card.move', id: id['A']!, toListId: dst, afterId: id['Z']! })
    expect(titles(dst)).toEqual(['X', 'Y', 'A', 'Z'])
  })

  it('afterId of the first card puts the card at the top', () => {
    const { dst, id } = setup()
    applyMutation(db, { type: 'card.move', id: id['A']!, toListId: dst, beforeId: null, afterId: id['X']! })
    expect(titles(dst)).toEqual(['A', 'X', 'Y', 'Z'])
  })

  it('a chain of beforeId moves builds the list top to bottom', () => {
    // The "most urgent first" pattern: each card goes under the last.
    const { dst, id } = setup()
    applyMutation(db, { type: 'card.move', id: id['A']!, toListId: dst, beforeId: id['Z']! })
    applyMutation(db, { type: 'card.move', id: id['B']!, toListId: dst, beforeId: id['A']! })
    applyMutation(db, { type: 'card.move', id: id['C']!, toListId: dst, beforeId: id['B']! })
    expect(titles(dst)).toEqual(['X', 'Y', 'Z', 'A', 'B', 'C'])
  })

  it('reordering within a list with no neighbours moves the card to the end', () => {
    const { dst, id } = setup()
    applyMutation(db, { type: 'card.move', id: id['X']!, toListId: dst })
    expect(titles(dst)).toEqual(['Y', 'Z', 'X'])
  })

  it('a neighbour from another list is ignored, so the card is appended', () => {
    const { dst, id } = setup()
    applyMutation(db, { type: 'card.move', id: id['A']!, toListId: dst, beforeId: id['B']! })
    expect(titles(dst)).toEqual(['X', 'Y', 'Z', 'A'])
  })

  it('copes with two cards already sharing a position key', () => {
    // Lists moved into by the old code can hold equal keys.
    const { dst, id } = setup()
    const xKey = db.select({ p: card.position }).from(card).where(eq(card.id, id['X']!)).get()!.p
    db.update(card).set({ position: xKey }).where(eq(card.id, id['Y']!)).run()
    applyMutation(db, { type: 'card.move', id: id['A']!, toListId: dst, beforeId: id['X']! })
    const order = titles(dst)
    expect(order.indexOf('A')).toBe(order.indexOf('Z') - 1)
    expect(order).toHaveLength(4)
  })
})
