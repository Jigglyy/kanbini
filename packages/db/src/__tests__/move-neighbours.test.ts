import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { applyMutation, ensureDefaultProjectId } from '../crud'
import { getBoardView, getCardView, listBoards } from '../data'
import type { Db } from '../client'
import { board, card, checklistItem, list } from '../schema'
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

// The same rules for the other fractional-index moves. list.move is
// reachable from MCP (kanbini_move_list); board.move and
// checklistItem.move from the local HTTP API.

function boardWithLists(names: string[]) {
  const projectId = ensureDefaultProjectId(db)
  const boardId = applyMutation(db, { type: 'board.create', projectId, name: 'B' }).id
  const id: Record<string, string> = {}
  for (const n of names) {
    id[n] = applyMutation(db, { type: 'list.create', boardId, name: n }).id
  }
  return { boardId, id }
}

function listNames(boardId: string): string[] {
  return getBoardView(db, boardId)!.lists.map((l) => l.name)
}

describe('list.move with missing neighbours', () => {
  it('no neighbours moves the list to the far right', () => {
    const { boardId, id } = boardWithLists(['A', 'B', 'C', 'D'])
    applyMutation(db, { type: 'list.move', id: id['A']! })
    applyMutation(db, { type: 'list.move', id: id['B']! })
    expect(listNames(boardId)).toEqual(['C', 'D', 'A', 'B'])
  })

  it('only beforeId puts the list directly right of that list', () => {
    const { boardId, id } = boardWithLists(['A', 'B', 'C', 'D'])
    applyMutation(db, { type: 'list.move', id: id['D']!, beforeId: id['A']! })
    expect(listNames(boardId)).toEqual(['A', 'D', 'B', 'C'])
  })

  it('only afterId puts the list directly left of that list', () => {
    const { boardId, id } = boardWithLists(['A', 'B', 'C', 'D'])
    applyMutation(db, { type: 'list.move', id: id['A']!, afterId: id['D']! })
    expect(listNames(boardId)).toEqual(['B', 'C', 'A', 'D'])
  })

  it('afterId of the first list puts the list at the far left', () => {
    const { boardId, id } = boardWithLists(['A', 'B', 'C'])
    applyMutation(db, { type: 'list.move', id: id['C']!, beforeId: null, afterId: id['A']! })
    expect(listNames(boardId)).toEqual(['C', 'A', 'B'])
  })

  it('a neighbour from another board is ignored, so the list goes far right', () => {
    const { boardId, id } = boardWithLists(['A', 'B', 'C'])
    const other = boardWithLists(['X'])
    applyMutation(db, { type: 'list.move', id: id['A']!, beforeId: other.id['X']! })
    expect(listNames(boardId)).toEqual(['B', 'C', 'A'])
  })

  it('copes with two lists already sharing a position key', () => {
    const { boardId, id } = boardWithLists(['A', 'B', 'C', 'D'])
    const aKey = db.select({ p: list.position }).from(list).where(eq(list.id, id['A']!)).get()!.p
    db.update(list).set({ position: aKey }).where(eq(list.id, id['B']!)).run()
    applyMutation(db, { type: 'list.move', id: id['D']!, beforeId: id['A']! })
    const order = listNames(boardId)
    expect(order.indexOf('D')).toBe(order.indexOf('C') - 1)
    expect(order).toHaveLength(4)
  })
})

function boards(names: string[]) {
  const projectId = ensureDefaultProjectId(db)
  const id: Record<string, string> = {}
  for (const n of names) {
    id[n] = applyMutation(db, { type: 'board.create', projectId, name: n }).id
  }
  return id
}

function boardNames(): string[] {
  return listBoards(db).map((b) => b.name)
}

describe('board.move with missing neighbours', () => {
  it('no neighbours moves the board to the end', () => {
    const id = boards(['A', 'B', 'C', 'D'])
    applyMutation(db, { type: 'board.move', id: id['A']! })
    applyMutation(db, { type: 'board.move', id: id['B']! })
    expect(boardNames()).toEqual(['C', 'D', 'A', 'B'])
  })

  it('only beforeId puts the board directly after that board', () => {
    const id = boards(['A', 'B', 'C', 'D'])
    applyMutation(db, { type: 'board.move', id: id['D']!, beforeId: id['A']! })
    expect(boardNames()).toEqual(['A', 'D', 'B', 'C'])
  })

  it('only afterId puts the board directly before that board', () => {
    const id = boards(['A', 'B', 'C', 'D'])
    applyMutation(db, { type: 'board.move', id: id['A']!, afterId: id['D']! })
    expect(boardNames()).toEqual(['B', 'C', 'A', 'D'])
  })

  it('afterId of the first board puts the board first', () => {
    const id = boards(['A', 'B', 'C'])
    applyMutation(db, { type: 'board.move', id: id['C']!, beforeId: null, afterId: id['A']! })
    expect(boardNames()).toEqual(['C', 'A', 'B'])
  })

  it('an unknown neighbour is ignored, so the board goes to the end', () => {
    const id = boards(['A', 'B', 'C'])
    applyMutation(db, { type: 'board.move', id: id['A']!, beforeId: 'no-such-board' })
    expect(boardNames()).toEqual(['B', 'C', 'A'])
  })

  it('copes with two boards already sharing a position key', () => {
    const id = boards(['A', 'B', 'C', 'D'])
    const aKey = db.select({ p: board.position }).from(board).where(eq(board.id, id['A']!)).get()!.p
    db.update(board).set({ position: aKey }).where(eq(board.id, id['B']!)).run()
    applyMutation(db, { type: 'board.move', id: id['D']!, beforeId: id['A']! })
    const order = boardNames()
    expect(order.indexOf('D')).toBe(order.indexOf('C') - 1)
    expect(order).toHaveLength(4)
  })
})

function checklists() {
  const { src } = setup()
  const cardId = applyMutation(db, { type: 'card.create', listId: src, title: 'Card' }).id
  const one = applyMutation(db, { type: 'checklist.create', cardId, name: 'One' }).id
  const two = applyMutation(db, { type: 'checklist.create', cardId, name: 'Two' }).id
  const id: Record<string, string> = {}
  for (const t of ['A', 'B', 'C', 'D']) {
    id[t] = applyMutation(db, { type: 'checklistItem.create', checklistId: one, text: t }).id
  }
  for (const t of ['X', 'Y']) {
    id[t] = applyMutation(db, { type: 'checklistItem.create', checklistId: two, text: t }).id
  }
  return { cardId, one, two, id }
}

function itemTexts(cardId: string, checklistId: string): string[] {
  const view = getCardView(db, cardId)!
  return view.checklists.find((c) => c.id === checklistId)!.items.map((i) => i.text)
}

describe('checklistItem.move with missing neighbours', () => {
  it('no neighbours moves the item to the end, in call order', () => {
    const { cardId, one, id } = checklists()
    applyMutation(db, { type: 'checklistItem.move', id: id['A']!, toChecklistId: one })
    applyMutation(db, { type: 'checklistItem.move', id: id['B']!, toChecklistId: one })
    expect(itemTexts(cardId, one)).toEqual(['C', 'D', 'A', 'B'])
  })

  it('no neighbours into another checklist appends there', () => {
    const { cardId, one, two, id } = checklists()
    applyMutation(db, { type: 'checklistItem.move', id: id['B']!, toChecklistId: two })
    applyMutation(db, { type: 'checklistItem.move', id: id['A']!, toChecklistId: two })
    expect(itemTexts(cardId, two)).toEqual(['X', 'Y', 'B', 'A'])
    expect(itemTexts(cardId, one)).toEqual(['C', 'D'])
  })

  it('only beforeId puts the item directly below that item', () => {
    const { cardId, one, id } = checklists()
    applyMutation(db, { type: 'checklistItem.move', id: id['D']!, toChecklistId: one, beforeId: id['A']! })
    expect(itemTexts(cardId, one)).toEqual(['A', 'D', 'B', 'C'])
  })

  it('only afterId puts the item directly above that item', () => {
    const { cardId, one, id } = checklists()
    applyMutation(db, { type: 'checklistItem.move', id: id['A']!, toChecklistId: one, afterId: id['D']! })
    expect(itemTexts(cardId, one)).toEqual(['B', 'C', 'A', 'D'])
  })

  it('afterId of the first item puts the item at the top', () => {
    const { cardId, two, id } = checklists()
    applyMutation(db, {
      type: 'checklistItem.move',
      id: id['C']!,
      toChecklistId: two,
      beforeId: null,
      afterId: id['X']!
    })
    expect(itemTexts(cardId, two)).toEqual(['C', 'X', 'Y'])
  })

  it('a neighbour from another checklist is ignored, so the item is appended', () => {
    const { cardId, two, id } = checklists()
    applyMutation(db, { type: 'checklistItem.move', id: id['A']!, toChecklistId: two, beforeId: id['B']! })
    expect(itemTexts(cardId, two)).toEqual(['X', 'Y', 'A'])
  })

  it('copes with two items already sharing a position key', () => {
    const { cardId, one, id } = checklists()
    const aKey = db
      .select({ p: checklistItem.position })
      .from(checklistItem)
      .where(eq(checklistItem.id, id['A']!))
      .get()!.p
    db.update(checklistItem).set({ position: aKey }).where(eq(checklistItem.id, id['B']!)).run()
    applyMutation(db, { type: 'checklistItem.move', id: id['D']!, toChecklistId: one, beforeId: id['A']! })
    const order = itemTexts(cardId, one)
    expect(order.indexOf('D')).toBe(order.indexOf('C') - 1)
    expect(order).toHaveLength(4)
  })
})
