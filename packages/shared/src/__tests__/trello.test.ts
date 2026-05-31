import { describe, expect, it } from 'vitest'
import { zTrelloBoard, zTrelloImportSummary } from '../trello'

// zTrelloBoard is the trust boundary for the Import-from-Trello flow:
// main parses an untrusted .json file with it before the DB layer
// touches anything. Three jobs to cover here:
//   1. accept a representative real-shaped export (every field we map)
//   2. drop every other key Trello also ships (we use non-strict
//      objects on purpose - Trello's exports are huge)
//   3. backfill defaults for the optional fields we tolerate missing.

// Minimal real-shaped sample. The actual exports include ~50 extra
// top-level keys (prefs, organizations, memberships, customFields,
// powerUps, …) - kept absent here so the "drops unknowns" test below
// can speak for itself, then re-added in that test.
const sampleBoard = {
  id: 'trello-board-1',
  name: 'My Trello Board',
  desc: 'Imported from Trello',
  lists: [
    { id: 'tl-1', name: 'To Do', pos: 65535 },
    { id: 'tl-2', name: 'Doing', pos: 131070 },
    { id: 'tl-3', name: 'Done', pos: 196605 }
  ],
  labels: [
    { id: 'lab-1', name: 'bug', color: 'red' },
    { id: 'lab-2', name: '', color: null }
  ],
  cards: [
    {
      id: 'tc-1',
      name: 'Plan launch',
      desc: '## Subtasks\n\n- write copy\n- ship',
      idList: 'tl-1',
      idLabels: ['lab-1'],
      due: '2026-06-01T17:00:00.000Z',
      dueComplete: false,
      pos: 65535,
      attachments: [{ id: 'att-1', url: 'https://trello.com/x' }]
    },
    {
      id: 'tc-2',
      name: 'Buy domain',
      desc: '',
      idList: 'tl-3',
      idLabels: [],
      due: null,
      dueComplete: false,
      pos: 131070,
      attachments: []
    }
  ],
  checklists: [
    {
      id: 'tcl-1',
      idCard: 'tc-1',
      name: 'Pre-flight',
      pos: 1,
      checkItems: [
        { id: 'tci-1', name: 'staging green', state: 'complete', pos: 1 },
        { id: 'tci-2', name: 'changelog', state: 'incomplete', pos: 2 }
      ]
    }
  ]
}

describe('zTrelloBoard', () => {
  it('parses a representative real-shaped export', () => {
    const out = zTrelloBoard.parse(sampleBoard)
    expect(out.name).toBe('My Trello Board')
    expect(out.lists).toHaveLength(3)
    expect(out.cards).toHaveLength(2)
    expect(out.labels).toHaveLength(2)
    expect(out.checklists[0]?.checkItems).toHaveLength(2)
    // Per-list/per-card sorting is the importer's job; here we only
    // assert pos floats are surfaced unchanged so the importer can sort.
    expect(out.lists.map((l) => l.pos)).toEqual([65535, 131070, 196605])
  })

  it('drops the dozens of keys Trello exports that we do not map', () => {
    const noisy = {
      ...sampleBoard,
      // Top-level junk the renderer/importer must never see.
      prefs: { background: 'blue', backgroundImage: null },
      memberships: [{ idMember: 'm1', memberType: 'admin' }],
      customFields: [],
      organizationId: 'org-x',
      powerUps: [],
      lists: sampleBoard.lists.map((l) => ({
        ...l,
        idBoard: 'trello-board-1',
        subscribed: false,
        // closed lists exist in Trello but we deliberately don't carry
        // the flag through (importing as active is the right default).
        closed: true
      })),
      cards: sampleBoard.cards.map((c) => ({
        ...c,
        idBoard: 'trello-board-1',
        idMembers: [],
        idChecklists: ['tcl-1'],
        badges: { votes: 0, comments: 5 },
        cover: { color: 'red' }
      }))
    }
    const out = zTrelloBoard.parse(noisy)
    // No 'closed' carried through.
    expect((out.lists[0] as Record<string, unknown>).closed).toBeUndefined()
    // No 'prefs' / 'memberships' / 'badges' carried through.
    expect((out as Record<string, unknown>).prefs).toBeUndefined()
    expect((out as Record<string, unknown>).memberships).toBeUndefined()
    expect(
      (out.cards[0] as Record<string, unknown>).badges
    ).toBeUndefined()
  })

  it('fills defaults for the optional fields we tolerate missing', () => {
    const minimal = {
      id: 'b',
      name: 'Tiny',
      cards: [{ id: 'c', idList: 'l' }],
      lists: [{ id: 'l' }]
    }
    const out = zTrelloBoard.parse(minimal)
    expect(out.desc).toBe('')
    expect(out.labels).toEqual([])
    expect(out.checklists).toEqual([])
    expect(out.cards[0]?.desc).toBe('')
    expect(out.cards[0]?.idLabels).toEqual([])
    expect(out.cards[0]?.due).toBeNull()
    expect(out.cards[0]?.attachments).toEqual([])
    expect(out.lists[0]?.name).toBe('')
    expect(out.lists[0]?.pos).toBe(0)
  })

  it('rejects an obviously-not-a-trello-board input', () => {
    // Empty board name - the only required-non-empty field at the top.
    expect(() => zTrelloBoard.parse({ id: 'x', name: '' })).toThrow()
    // Card with no idList - the importer would have nowhere to place it.
    expect(() =>
      zTrelloBoard.parse({
        id: 'x',
        name: 'B',
        cards: [{ id: 'c', name: 'orphan' }]
      })
    ).toThrow()
  })
})

describe('zTrelloImportSummary', () => {
  it('round-trips a summary', () => {
    const v = {
      boardId: 'new-board-id',
      boardName: 'My Trello Board',
      counts: {
        lists: 3,
        cards: 2,
        labels: 2,
        cardLabels: 1,
        checklists: 1,
        checklistItems: 2
      },
      skipped: { attachments: 1, cards: 0, checklists: 0 }
    }
    expect(zTrelloImportSummary.parse(v)).toEqual(v)
  })
})
