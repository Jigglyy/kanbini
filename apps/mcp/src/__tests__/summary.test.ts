import { describe, expect, it } from 'vitest'
import type { BoardView, CardView } from '@kanbini/shared'
import {
  filterCards,
  localDate,
  nextLocalDay,
  parseLocalDate,
  summarizeBoard,
  summarizeCard
} from '../summary'

// The light reads: one short line per card, and the list filters.

const day = (s: string) => parseLocalDate(s)

function card(over: Partial<CardView> = {}): CardView {
  return {
    id: 'c1',
    number: 7,
    boardId: 'b1',
    title: 'Fix login',
    description: null,
    position: 'a0',
    completed: false,
    dueAt: null,
    priority: null,
    repeat: null,
    collapsed: null,
    labelIds: [],
    checklists: [],
    comments: [],
    attachments: [],
    coverAttachmentId: null,
    activities: [],
    blockedBy: [],
    blocking: [],
    ...over
  } as CardView
}

const blocker = (completed: boolean) => ({
  cardId: 'x',
  number: 1,
  title: 'Other',
  completed,
  archived: false,
  boardId: 'b1',
  boardName: 'B',
  listName: 'L'
})

describe('summarizeCard', () => {
  const names = new Map([
    ['lab-bug', 'Bug'],
    ['lab-ui', 'UI']
  ])

  it('keeps a bare card to its number and title', () => {
    expect(summarizeCard(card(), names)).toEqual({ number: 7, title: 'Fix login' })
  })

  it('adds only what applies, with label names and a checklist tally', () => {
    const s = summarizeCard(
      card({
        completed: true,
        dueAt: day('2026-11-07'),
        priority: 'high',
        labelIds: ['lab-ui', 'lab-bug', 'gone'],
        description: 'Steps...',
        checklists: [
          {
            id: 'k',
            name: 'Do',
            position: 'a0',
            items: [
              { id: 'i1', text: 'a', completed: true, position: 'a0' },
              { id: 'i2', text: 'b', completed: false, position: 'a1' }
            ]
          },
          { id: 'k2', name: 'More', position: 'a1', items: [{ id: 'i3', text: 'c', completed: true, position: 'a0' }] }
        ] as CardView['checklists'],
        comments: [{}, {}] as CardView['comments'],
        repeat: { unit: 'week', every: 2 }
      }),
      names
    )
    expect(s).toEqual({
      number: 7,
      title: 'Fix login',
      completed: true,
      due: '2026-11-07',
      priority: 'high',
      labels: ['UI', 'Bug'],
      checklist: '2/3',
      description: true,
      comments: 2,
      repeat: 'Every 2 weeks'
    })
  })

  it('is blocked only while a blocker is open, and never once completed', () => {
    expect(summarizeCard(card({ blockedBy: [blocker(false)] }), names).blocked).toBe(true)
    expect(summarizeCard(card({ blockedBy: [blocker(true)] }), names).blocked).toBeUndefined()
    expect(
      summarizeCard(card({ completed: true, blockedBy: [blocker(false)] }), names).blocked
    ).toBeUndefined()
  })

  it('treats a blank description as none', () => {
    expect(summarizeCard(card({ description: '  \n ' }), names).description).toBeUndefined()
  })
})

describe('summarizeBoard', () => {
  const view = {
    project: { id: 'p', name: 'P' },
    board: { id: 'b1', name: 'Dice', color: null, background: null, swimlaneMode: null },
    labels: [{ id: 'lab-bug', name: 'Bug', color: 'red' }],
    lists: [
      {
        id: 'l1',
        name: 'To Do',
        color: null,
        closed: false,
        position: 'a0',
        wipLimit: 5,
        sortMode: 'due-asc',
        onEnter: null,
        cardDensity: null,
        visibleCardLimit: null,
        cards: [card({ labelIds: ['lab-bug'] })]
      },
      {
        id: 'l2',
        name: 'Old',
        color: null,
        closed: true,
        position: 'a1',
        wipLimit: null,
        sortMode: null,
        onEnter: { kind: 'complete' },
        cardDensity: 'compact',
        visibleCardLimit: 0,
        cards: [card(), card({ number: 8 })]
      }
    ]
  } as unknown as BoardView

  it('lists every list with its settings and one line per card, no card ids', () => {
    expect(summarizeBoard(view)).toEqual({
      board: { id: 'b1', name: 'Dice' },
      labels: [{ id: 'lab-bug', name: 'Bug', color: 'red' }],
      lists: [
        {
          id: 'l1',
          name: 'To Do',
          cardCount: 1,
          wipLimit: 5,
          sortMode: 'due-asc',
          cards: [{ number: 7, title: 'Fix login', labels: ['Bug'] }]
        },
        { id: 'l2', name: 'Old', cardCount: 2, closed: true, onEnter: 'complete', cards: [] }
      ]
    })
  })
})

describe('summarizeBoard on a long list', () => {
  it('shows the first cards and counts the rest', () => {
    const long = {
      project: { id: 'p', name: 'P' },
      board: { id: 'b1', name: 'B', color: null, background: null, swimlaneMode: null },
      labels: [],
      lists: [
        {
          id: 'l1',
          name: 'Done',
          color: null,
          closed: false,
          position: 'a0',
          wipLimit: null,
          sortMode: null,
          onEnter: null,
          cardDensity: null,
          visibleCardLimit: null,
          cards: Array.from({ length: 60 }, (_, i) => card({ number: i + 1 }))
        }
      ]
    } as unknown as BoardView
    const l = summarizeBoard(long).lists[0]!
    expect(l.cards.map((c) => c.number)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
    expect(l).toMatchObject({ cardCount: 60, moreCards: 10 })
    expect(summarizeBoard(long, 100).lists[0]!.moreCards).toBeUndefined()
  })
})

describe('filterCards', () => {
  const cards = [
    card({ id: 'a', title: 'Login bug', completed: false, labelIds: ['bug'], priority: 'high', dueAt: day('2026-11-05') }),
    card({ id: 'b', title: 'Docs', description: 'write the LOGIN page', completed: true }),
    card({ id: 'c', title: 'Polish', dueAt: day('2026-11-10') })
  ]
  const ids = (cs: CardView[]) => cs.map((c) => c.id)

  it('filters by status, label, priority and text', () => {
    expect(ids(filterCards(cards, { status: 'open' }))).toEqual(['a', 'c'])
    expect(ids(filterCards(cards, { status: 'completed' }))).toEqual(['b'])
    expect(ids(filterCards(cards, { labelId: 'bug' }))).toEqual(['a'])
    expect(ids(filterCards(cards, { priority: 'none' }))).toEqual(['b', 'c'])
    expect(ids(filterCards(cards, { query: 'login' }))).toEqual(['a', 'b'])
  })

  it('filters by due window (inclusive days) and by having a due date', () => {
    expect(
      ids(filterCards(cards, { dueFrom: day('2026-11-05'), dueTo: nextLocalDay(day('2026-11-05')) - 1 }))
    ).toEqual(['a'])
    expect(ids(filterCards(cards, { dueFrom: day('2026-11-06') }))).toEqual(['c'])
    expect(ids(filterCards(cards, { hasDue: false }))).toEqual(['b'])
  })
})

describe('dates', () => {
  it('round-trips a local day', () => {
    expect(localDate(parseLocalDate('2026-02-28'))).toBe('2026-02-28')
    expect(localDate(nextLocalDay(parseLocalDate('2026-12-31')))).toBe('2027-01-01')
  })

  it('rejects things that are not real days', () => {
    expect(() => parseLocalDate('tomorrow')).toThrow(/YYYY-MM-DD/)
    expect(() => parseLocalDate('2026-02-30')).toThrow(/not a real date/)
  })
})
