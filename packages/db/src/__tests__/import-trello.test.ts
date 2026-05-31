import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type TrelloBoard, zTrelloBoard } from '@kanbini/shared'
import { type Db } from '../client'
import { getBoardView, listBoards } from '../data'
import { importFromTrello } from '../import-trello'
import { createTestDb } from './_setup'

// Trello import (ADR-0028). Additive - never wipes - so the
// expectation is "one fresh board appears, existing boards untouched."

let db: Db
let close: () => void
beforeEach(() => {
  const t = createTestDb()
  db = t.db
  close = t.close
})
afterEach(() => close())

function fixture(): TrelloBoard {
  // Real-shape Trello export, validated through zTrelloBoard so the
  // type matches whatever main passes the importer in production.
  return zTrelloBoard.parse({
    id: 'trello-1',
    name: 'My Trello Board',
    desc: 'Imported from Trello',
    lists: [
      // Intentionally out-of-order by pos so the importer's sort is exercised.
      { id: 'L-2', name: 'Doing', pos: 200 },
      { id: 'L-1', name: 'Todo', pos: 100 },
      { id: 'L-3', name: 'Done', pos: 300 }
    ],
    labels: [
      { id: 'lab-used', name: 'bug', color: 'red' },
      { id: 'lab-unused', name: 'dropme', color: 'blue' }
    ],
    cards: [
      {
        id: 'C-1',
        name: 'Plan launch',
        desc: 'body',
        idList: 'L-1',
        idLabels: ['lab-used'],
        due: null,
        dueComplete: false,
        pos: 100,
        attachments: [
          { id: 'a1', url: 'https://trello.com/x' },
          { id: 'a2', url: 'https://trello.com/y' }
        ]
      },
      {
        id: 'C-2',
        name: 'Buy domain',
        desc: '',
        idList: 'L-3',
        idLabels: [],
        due: null,
        dueComplete: false,
        pos: 200,
        attachments: []
      }
    ],
    checklists: [
      {
        id: 'CL-1',
        idCard: 'C-1',
        name: 'Pre-flight',
        pos: 1,
        checkItems: [
          { id: 'I-1', name: 'staging green', state: 'complete', pos: 1 },
          { id: 'I-2', name: 'changelog', state: 'incomplete', pos: 2 }
        ]
      }
    ]
  })
}

describe('importFromTrello', () => {
  it('creates a new board with the expected counts in the summary', () => {
    const summary = importFromTrello(db, fixture())
    expect(summary.boardName).toBe('My Trello Board')
    expect(summary.counts).toEqual({
      lists: 3,
      cards: 2,
      labels: 1, // unused 'lab-unused' dropped
      cardLabels: 1,
      checklists: 1,
      checklistItems: 2
    })
    expect(summary.skipped.attachments).toBe(2)
  })

  it('mints fresh UUIDv7 ids - no Trello ids leak into the DB', () => {
    const summary = importFromTrello(db, fixture())
    expect(summary.boardId).not.toBe('trello-1')
    const view = getBoardView(db, summary.boardId)!
    for (const l of view.lists) expect(l.id).not.toMatch(/^L-/)
    for (const c of view.lists.flatMap((l) => l.cards)) {
      expect(c.id).not.toMatch(/^C-/)
    }
    for (const lab of view.labels) expect(lab.id).not.toMatch(/^lab-/)
  })

  it('sorts lists by Trello pos (the original order was scrambled)', () => {
    const summary = importFromTrello(db, fixture())
    const names = getBoardView(db, summary.boardId)!.lists.map((l) => l.name)
    expect(names).toEqual(['Todo', 'Doing', 'Done'])
  })

  it('drops unused labels and keeps only those referenced by a card', () => {
    const summary = importFromTrello(db, fixture())
    const labels = getBoardView(db, summary.boardId)!.labels
    expect(labels.map((l) => l.name)).toEqual(['bug'])
  })

  it('places cards into the right lists by Trello idList', () => {
    const summary = importFromTrello(db, fixture())
    const view = getBoardView(db, summary.boardId)!
    const todoCards = view.lists.find((l) => l.name === 'Todo')!.cards
    const doneCards = view.lists.find((l) => l.name === 'Done')!.cards
    expect(todoCards.map((c) => c.title)).toEqual(['Plan launch'])
    expect(doneCards.map((c) => c.title)).toEqual(['Buy domain'])
  })

  it('preserves the card description body verbatim', () => {
    const summary = importFromTrello(db, fixture())
    const planLaunch = getBoardView(db, summary.boardId)!
      .lists.find((l) => l.name === 'Todo')!
      .cards.find((c) => c.title === 'Plan launch')!
    expect(planLaunch.description).toBe('body')
  })

  it('imports checklists + items in the right state', () => {
    const summary = importFromTrello(db, fixture())
    const card = getBoardView(db, summary.boardId)!
      .lists.flatMap((l) => l.cards)
      .find((c) => c.title === 'Plan launch')!
    const cl = card.checklists[0]
    expect(cl?.name).toBe('Pre-flight')
    expect(cl?.items.map((i) => [i.text, i.completed])).toEqual([
      ['staging green', true],
      ['changelog', false]
    ])
  })

  it('is additive - existing boards stay untouched', () => {
    importFromTrello(db, fixture())
    importFromTrello(db, { ...fixture(), name: 'Another' })
    const names = listBoards(db).map((b) => b.name)
    expect(names).toContain('My Trello Board')
    expect(names).toContain('Another')
  })

  it('reports zero drops for a clean import', () => {
    const summary = importFromTrello(db, fixture())
    expect(summary.skipped.cards).toBe(0)
    expect(summary.skipped.checklists).toBe(0)
  })

  it('counts cards (and their checklists) dropped for an unknown idList', () => {
    // A card whose Trello list isn't in the export (e.g. the list was
    // deleted) used to vanish silently - the summary now records it so
    // the data loss is detectable.
    const base = fixture()
    const withOrphans: TrelloBoard = {
      ...base,
      cards: [
        ...base.cards,
        {
          id: 'C-orphan',
          name: 'On a deleted list',
          desc: '',
          idList: 'L-GONE', // no such list in `lists`
          idLabels: [],
          due: null,
          dueComplete: false,
          pos: 50,
          attachments: []
        }
      ],
      checklists: [
        ...base.checklists,
        {
          id: 'CL-orphan',
          idCard: 'C-orphan',
          name: 'Goes with the dropped card',
          pos: 1,
          checkItems: [{ id: 'IO-1', name: 'x', state: 'incomplete', pos: 1 }]
        }
      ]
    }
    const summary = importFromTrello(db, withOrphans)
    // Two real cards still imported; the orphan is dropped + counted.
    expect(summary.counts.cards).toBe(2)
    expect(summary.skipped.cards).toBe(1)
    // Only the checklist on a real card imports; the orphan's is dropped.
    expect(summary.counts.checklists).toBe(1)
    expect(summary.skipped.checklists).toBe(1)
    // And the orphan card really isn't on the board.
    const titles = getBoardView(db, summary.boardId)!
      .lists.flatMap((l) => l.cards)
      .map((c) => c.title)
    expect(titles).not.toContain('On a deleted list')
  })
})
