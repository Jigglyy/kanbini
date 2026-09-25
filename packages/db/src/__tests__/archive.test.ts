import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyMutation, ensureDefaultProjectId } from '../crud'
import {
  getArchivedItems,
  getBoardView,
  getCardView,
  listBoards
} from '../data'
import { searchCards } from '../search'
import { instantiateBoardTemplate, saveBoardTemplate } from '../templates'
import { applyMutationRecorded, undoOne } from '../undo'
import { type Db } from '../client'
import { createTestDb } from './_setup'

// Card + list archiving. The `card.archived` column shipped in schema v1
// and search + the home counts already honoured it, but nothing could
// set it and the board view ignored it - so an "archived" card would
// have vanished from search while still sitting on the board. These pin
// the now-consistent contract: archived = hidden everywhere the user
// looks, recoverable through getArchivedItems, undoable.

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

function seed() {
  const board = applyMutation(db, {
    type: 'board.create',
    projectId,
    name: 'Board'
  })
  const todo = applyMutation(db, {
    type: 'list.create',
    boardId: board.id,
    name: 'Todo'
  })
  const done = applyMutation(db, {
    type: 'list.create',
    boardId: board.id,
    name: 'Done'
  })
  const a = applyMutation(db, {
    type: 'card.create',
    listId: todo.id,
    title: 'Alpha zebra'
  })
  const b = applyMutation(db, {
    type: 'card.create',
    listId: todo.id,
    title: 'Beta zebra'
  })
  const c = applyMutation(db, {
    type: 'card.create',
    listId: done.id,
    title: 'Gamma'
  })
  return {
    boardId: board.id,
    todoId: todo.id,
    doneId: done.id,
    aId: a.id,
    bId: b.id,
    cId: c.id
  }
}

const archive = (id: string, archived = true) =>
  applyMutation(db, { type: 'card.update', id, patch: { archived } })

function cardIdsOnBoard(boardId: string): string[] {
  const view = getBoardView(db, boardId)
  return (view?.lists ?? []).flatMap((l) => l.cards.map((c) => c.id))
}

describe('card archive', () => {
  it('hides an archived card from the board view', () => {
    const s = seed()
    archive(s.aId)
    expect(cardIdsOnBoard(s.boardId)).toEqual([s.bId, s.cId])
  })

  it('hides it from search and the home card count too', () => {
    const s = seed()
    expect(searchCards(db, 'zebra').map((h) => h.cardId).sort()).toEqual(
      [s.aId, s.bId].sort()
    )
    archive(s.aId)
    expect(searchCards(db, 'zebra').map((h) => h.cardId)).toEqual([s.bId])
    expect(listBoards(db).find((b) => b.id === s.boardId)?.cardCount).toBe(2)
  })

  it('restoring puts the card back in the same slot', () => {
    const s = seed()
    const before = getBoardView(db, s.boardId)!.lists[0]!.cards.map((c) => c.id)
    archive(s.aId)
    archive(s.aId, false)
    const after = getBoardView(db, s.boardId)!.lists[0]!.cards.map((c) => c.id)
    expect(after).toEqual(before)
  })

  it('logs archived / unarchived activity rows', () => {
    const s = seed()
    archive(s.aId)
    archive(s.aId, false)
    const types = getCardView(db, s.aId)!.activities.map((a) => a.type)
    // Feed is newest-first.
    expect(types.slice(0, 2)).toEqual(['unarchived', 'archived'])
  })

  it('getCardView still returns an archived card', () => {
    const s = seed()
    archive(s.aId)
    expect(getCardView(db, s.aId)?.title).toBe('Alpha zebra')
  })

  it('undo of an archive brings the card back', () => {
    const s = seed()
    applyMutationRecorded(db, {
      type: 'card.update',
      id: s.aId,
      patch: { archived: true }
    })
    expect(cardIdsOnBoard(s.boardId)).not.toContain(s.aId)
    const res = undoOne(db, s.boardId)
    expect(res.applied).toBe(true)
    expect(cardIdsOnBoard(s.boardId)).toContain(s.aId)
  })

  it('board templates leave archived cards out', () => {
    const s = seed()
    archive(s.aId)
    const { id: templateId } = saveBoardTemplate(db, s.boardId, 'Tpl')
    const made = instantiateBoardTemplate(db, templateId)
    const titles = getBoardView(db, made.boardId)!
      .lists.flatMap((l) => l.cards.map((c) => c.title))
    expect(titles).not.toContain('Alpha zebra')
    expect(titles).toContain('Beta zebra')
  })
})

describe('getArchivedItems', () => {
  it('returns null for an unknown board', () => {
    expect(getArchivedItems(db, 'nope')).toBeNull()
  })

  it('is empty when nothing is archived', () => {
    const s = seed()
    expect(getArchivedItems(db, s.boardId)).toEqual({
      boardId: s.boardId,
      lists: [],
      cards: []
    })
  })

  it('lists archived cards with their list, newest first', async () => {
    const s = seed()
    archive(s.aId)
    // Distinct updatedAt so the order assertion isn't a same-ms tiebreak.
    await new Promise((r) => setTimeout(r, 5))
    archive(s.cId)
    const items = getArchivedItems(db, s.boardId)!
    expect(items.cards.map((c) => c.id)).toEqual([s.cId, s.aId])
    expect(items.cards[0]).toMatchObject({
      title: 'Gamma',
      listId: s.doneId,
      listName: 'Done',
      listClosed: false
    })
  })

  it('lists closed lists with their live card count', () => {
    const s = seed()
    archive(s.aId) // archived cards don't count as live
    applyMutation(db, {
      type: 'list.update',
      id: s.todoId,
      patch: { closed: true }
    })
    const items = getArchivedItems(db, s.boardId)!
    expect(items.lists).toEqual([
      { id: s.todoId, name: 'Todo', color: null, cardCount: 1 }
    ])
    // The archived card sits in a closed list - flagged so a caller
    // knows restoring the card alone won't make it visible.
    expect(items.cards.find((c) => c.id === s.aId)?.listClosed).toBe(true)
  })

  it('a closed list stays in the board view, flagged, for the renderer to hide', () => {
    const s = seed()
    applyMutation(db, {
      type: 'list.update',
      id: s.todoId,
      patch: { closed: true }
    })
    const lists = getBoardView(db, s.boardId)!.lists
    expect(lists.find((l) => l.id === s.todoId)?.closed).toBe(true)
  })

  it('scopes to the requested board', () => {
    const s = seed()
    const other = seed()
    archive(other.aId)
    expect(getArchivedItems(db, s.boardId)!.cards).toEqual([])
    expect(getArchivedItems(db, other.boardId)!.cards).toHaveLength(1)
  })
})

describe('card.setLabels board scoping', () => {
  it('rejects a label from another board and writes nothing', () => {
    const s = seed()
    const other = seed()
    const own = applyMutation(db, {
      type: 'label.create',
      boardId: s.boardId,
      name: 'Mine',
      color: 'red'
    })
    const foreign = applyMutation(db, {
      type: 'label.create',
      boardId: other.boardId,
      name: 'Theirs',
      color: 'blue'
    })
    applyMutation(db, { type: 'card.setLabels', id: s.aId, labelIds: [own.id] })
    expect(() =>
      applyMutation(db, {
        type: 'card.setLabels',
        id: s.aId,
        labelIds: [own.id, foreign.id]
      })
    ).toThrow(/different board/)
    // The existing assignment survived the rejected call.
    expect(getCardView(db, s.aId)?.labelIds).toEqual([own.id])
  })

  it('rejects an unknown label id', () => {
    const s = seed()
    expect(() =>
      applyMutation(db, {
        type: 'card.setLabels',
        id: s.aId,
        labelIds: ['no-such-label']
      })
    ).toThrow(/not found/)
  })

  it('still accepts the card\'s own labels and an empty set', () => {
    const s = seed()
    const own = applyMutation(db, {
      type: 'label.create',
      boardId: s.boardId,
      name: 'Mine',
      color: 'red'
    })
    applyMutation(db, { type: 'card.setLabels', id: s.aId, labelIds: [own.id] })
    expect(getCardView(db, s.aId)?.labelIds).toEqual([own.id])
    applyMutation(db, { type: 'card.setLabels', id: s.aId, labelIds: [] })
    expect(getCardView(db, s.aId)?.labelIds).toEqual([])
  })
})
