import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { localDayStart, nextDueAt, type CardView } from '@kanbini/shared'
import { applyMutation } from '../crud'
import { getBoardView, getCardView } from '../data'
import { exportToFolder } from '../export'
import { importFromFolder } from '../import'
import { instantiateBoardTemplate, saveBoardTemplate } from '../templates'
import {
  applyMutationRecorded,
  applyMutationsRecorded,
  redoOne,
  undoOne,
  undoStatus
} from '../undo'
import { type Db } from '../client'
import { createTestDb, type TestDb } from './_setup'

// Repeating cards. The spawn is recorded by applyMutationRecorded (the
// path every real caller takes), so these tests go through it. Pinned:
//   • completing a repeating card adds the next one to the list it was
//     worked in: same title / description / priority / labels, unticked
//     checklists, due one repeat later, rule moved onto it
//   • dropping it into an auto-complete list sends the next one back to
//     the list it came from
//   • no spawn for: a one-off card, an already-completed card, a patch
//     that also clears the rule, a raw (unrecorded) applyMutation
//   • one Ctrl+Z undoes both; redo recreates the SAME copy id
//   • bulk completes group everything into one undo step
//   • rule survives delete + undo, export / import, and board templates

let t: TestDb
let db: Db

beforeEach(() => {
  t = createTestDb()
  db = t.db
})
afterEach(() => t.close())

const WEEKLY = { unit: 'week', every: 1 } as const

function board(): { boardId: string; todo: string; done: string } {
  const boardId = applyMutation(db, { type: 'board.create', name: 'Chores' }).id
  const todo = applyMutation(db, { type: 'list.create', boardId, name: 'To do' }).id
  const done = applyMutation(db, { type: 'list.create', boardId, name: 'Done' }).id
  return { boardId, todo, done }
}

function repeating(listId: string, title = 'Water the plants', dueAt?: number): string {
  const id = applyMutation(db, { type: 'card.create', listId, title }).id
  applyMutation(db, {
    type: 'card.update',
    id,
    patch: { repeat: WEEKLY, ...(dueAt !== undefined ? { dueAt } : {}) }
  })
  return id
}

const cardsIn = (boardId: string, listId: string): CardView[] =>
  getBoardView(db, boardId)!.lists.find((l) => l.id === listId)!.cards

const complete = (id: string) =>
  applyMutationRecorded(db, { type: 'card.update', id, patch: { completed: true } })

describe('setting a rule', () => {
  it('stores it, shows it in both views, and logs it', () => {
    const { todo } = board()
    const id = repeating(todo)
    const view = getCardView(db, id)!
    expect(view.repeat).toEqual(WEEKLY)
    expect(view.activities[0]).toMatchObject({ type: 'repeat-set', data: { repeat: WEEKLY } })

    applyMutation(db, { type: 'card.update', id, patch: { repeat: null } })
    expect(getCardView(db, id)!.repeat).toBeNull()
    expect(getCardView(db, id)!.activities[0]!.type).toBe('repeat-cleared')
  })
})

describe('completing a repeating card', () => {
  it('adds the next occurrence to the same list', () => {
    const { boardId, todo } = board()
    const due = localDayStart(Date.now())
    const id = repeating(todo, 'Water the plants', due)
    applyMutation(db, { type: 'card.update', id, patch: { description: 'Both balconies', priority: 'high' } })
    const labelId = applyMutation(db, { type: 'label.create', boardId, name: 'Home', color: 'green' }).id
    applyMutation(db, { type: 'card.setLabels', id, labelIds: [labelId] })
    const clId = applyMutation(db, { type: 'checklist.create', cardId: id, name: 'Steps' }).id
    const itemId = applyMutation(db, { type: 'checklistItem.create', checklistId: clId, text: 'Fill can' }).id
    applyMutation(db, { type: 'checklistItem.update', id: itemId, patch: { completed: true } })
    const other = applyMutation(db, { type: 'card.create', listId: todo, title: 'Other' }).id

    complete(id)

    const cards = cardsIn(boardId, todo)
    expect(cards.map((c) => c.id)).toEqual([id, other, expect.any(String)])
    const copy = cards[2]!
    expect(copy).toMatchObject({
      title: 'Water the plants',
      description: 'Both balconies',
      priority: 'high',
      completed: false,
      repeat: WEEKLY,
      labelIds: [labelId],
      dueAt: nextDueAt(due, WEEKLY)
    })
    expect(copy.checklists).toMatchObject([
      { name: 'Steps', items: [{ text: 'Fill can', completed: false }] }
    ])
    expect(copy.activities[0]).toMatchObject({ type: 'repeat-created', data: { fromCardId: id } })

    const orig = getCardView(db, id)!
    expect(orig.completed).toBe(true)
    expect(orig.repeat).toBeNull()
    expect(orig.activities[0]).toMatchObject({ type: 'repeat-next', data: { cardId: copy.id } })
  })

  it('sends the next one back to where it came from when dropped in an auto-complete list', () => {
    const { boardId, todo, done } = board()
    applyMutation(db, { type: 'list.update', id: done, patch: { onEnter: { kind: 'complete' } } })
    const id = repeating(todo)
    applyMutationRecorded(db, { type: 'card.move', id, toListId: done })

    expect(cardsIn(boardId, done).map((c) => [c.id, c.completed])).toEqual([[id, true]])
    const next = cardsIn(boardId, todo)
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ completed: false, repeat: WEEKLY })
  })

  it('does not spawn for a one-off card', () => {
    const { boardId, todo } = board()
    const id = applyMutation(db, { type: 'card.create', listId: todo, title: 'Once' }).id
    complete(id)
    expect(cardsIn(boardId, todo)).toHaveLength(1)
  })

  it('does not spawn again for a card that is already complete', () => {
    const { boardId, todo } = board()
    const id = repeating(todo)
    complete(id)
    // Reopen and put the rule back by hand, then "complete" twice.
    applyMutation(db, { type: 'card.update', id, patch: { completed: true } })
    expect(cardsIn(boardId, todo)).toHaveLength(2)
    complete(id)
    expect(cardsIn(boardId, todo)).toHaveLength(2)
  })

  it('does not spawn when the same patch stops the repeat', () => {
    const { boardId, todo } = board()
    const id = repeating(todo)
    applyMutationRecorded(db, {
      type: 'card.update',
      id,
      patch: { completed: true, repeat: null }
    })
    expect(cardsIn(boardId, todo)).toHaveLength(1)
    expect(getCardView(db, id)!.repeat).toBeNull()
  })

  it('does not spawn on a raw, unrecorded apply', () => {
    const { boardId, todo } = board()
    const id = repeating(todo)
    applyMutation(db, { type: 'card.update', id, patch: { completed: true } })
    expect(cardsIn(boardId, todo)).toHaveLength(1)
  })
})

describe('undo / redo', () => {
  it('undoes the completion and the next occurrence in one step', () => {
    const { boardId, todo } = board()
    const id = repeating(todo)
    complete(id)
    expect(undoStatus(db).undoDescription).toBe('Schedule the next repeat (2 changes)')

    expect(undoOne(db, boardId).applied).toBe(true)
    const cards = cardsIn(boardId, todo)
    expect(cards.map((c) => c.id)).toEqual([id])
    expect(cards[0]).toMatchObject({ completed: false, repeat: WEEKLY })
  })

  it('redo brings back the same next card', () => {
    const { boardId, todo } = board()
    const id = repeating(todo)
    complete(id)
    const copyId = cardsIn(boardId, todo)[1]!.id
    undoOne(db, boardId)
    redoOne(db, boardId)
    const cards = cardsIn(boardId, todo)
    expect(cards.map((c) => c.id)).toEqual([id, copyId])
    expect(cards[0]!.repeat).toBeNull()
    expect(cards[1]!.repeat).toEqual(WEEKLY)
    // A second undo / redo cycle stays consistent.
    undoOne(db, boardId)
    expect(cardsIn(boardId, todo).map((c) => c.id)).toEqual([id])
  })

  it('groups a bulk complete into one undo step', () => {
    const { boardId, todo } = board()
    const a = repeating(todo, 'A')
    const b = repeating(todo, 'B')
    const once = applyMutation(db, { type: 'card.create', listId: todo, title: 'Once' }).id
    applyMutationsRecorded(db, [a, b, once].map((id) => ({
      type: 'card.update' as const,
      id,
      patch: { completed: true }
    })))
    expect(cardsIn(boardId, todo)).toHaveLength(5)
    expect(undoStatus(db).undoDescription).toBe('Edit card (5 changes)')

    undoOne(db, boardId)
    expect(cardsIn(boardId, todo).map((c) => c.completed)).toEqual([false, false, false])
  })

  it('restores the rule when a deleted repeating card is undone', () => {
    const { boardId, todo } = board()
    const id = repeating(todo)
    applyMutationRecorded(db, { type: 'card.delete', id })
    undoOne(db, boardId)
    expect(getCardView(db, id)!.repeat).toEqual(WEEKLY)
  })

  it('undoes setting the rule', () => {
    const { boardId, todo } = board()
    const id = applyMutation(db, { type: 'card.create', listId: todo, title: 'X' }).id
    applyMutationRecorded(db, { type: 'card.update', id, patch: { repeat: WEEKLY } })
    undoOne(db, boardId)
    expect(getCardView(db, id)!.repeat).toBeNull()
  })
})

describe('carried through', () => {
  it('export / import', async () => {
    const { todo } = board()
    const id = repeating(todo)
    const ud = mkdtempSync(join(tmpdir(), 'kanbini-repeat-'))
    try {
      await exportToFolder(db, ud, join(ud, 'export'))
      const fresh = createTestDb()
      try {
        await importFromFolder(fresh.db, ud, join(ud, 'export'))
        expect(getCardView(fresh.db, id)!.repeat).toEqual(WEEKLY)
      } finally {
        fresh.close()
      }
    } finally {
      rmSync(ud, { recursive: true, force: true })
    }
  })

  it('board templates', () => {
    const { boardId, todo } = board()
    repeating(todo, 'Weekly review')
    const tpl = saveBoardTemplate(db, boardId, 'Chores template')
    const made = instantiateBoardTemplate(db, tpl.id)
    expect(made.boardId).not.toBe(boardId)
    const cards = getBoardView(db, made.boardId)!.lists.flatMap((l) => l.cards)
    expect(cards.find((c) => c.title === 'Weekly review')?.repeat).toEqual(WEEKLY)
  })
})
