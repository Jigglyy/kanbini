import { describe, expect, it } from 'vitest'
import type { BoardView, CardView } from '@kanbini/shared'
import { filterByLabels, pruneLabelFilter } from '../label-filter'

// The header label filter + the stale-id pruning that backs it. The
// pruning exists because deleting the label you're filtering by would
// otherwise leave its id in the active set, matching no card, hiding
// every card with no chip left to clear (regression guard for the
// label-delete editor).

function makeCard(id: string, labelIds: string[]): CardView {
  return {
    id,
    title: id,
    description: null,
    position: 'a',
    completed: false,
    dueAt: null,
    priority: null,
    labelIds,
    checklists: [],
    comments: [],
    attachments: [],
    coverAttachmentId: null,
    activities: []
  }
}

function makeBoard(
  cards: CardView[],
  labelIds: string[] = ['l1', 'l2']
): BoardView {
  return {
    project: { id: 'p', name: 'P' },
    board: {
      id: 'b1',
      name: 'B',
      color: null,
      background: null,
      swimlaneMode: null
    },
    labels: labelIds.map((id) => ({ id, name: id, color: 'oklch(0.6 0.1 0)' })),
    lists: [
      {
        id: 'L',
        name: 'L',
        color: null,
        closed: false,
        position: 'a',
        wipLimit: null,
        sortMode: null,
        onEnter: null,
        cards
      }
    ]
  }
}

describe('filterByLabels', () => {
  it('returns the board unchanged (same ref) when no filter is active', () => {
    const b = makeBoard([makeCard('c1', ['l1'])])
    expect(filterByLabels(b, new Set())).toBe(b)
  })

  it('keeps only cards carrying at least one active label (OR semantics)', () => {
    const b = makeBoard([
      makeCard('c1', ['l1']),
      makeCard('c2', ['l2']),
      makeCard('c3', [])
    ])
    const out = filterByLabels(b, new Set(['l1']))
    expect(out.lists[0]!.cards.map((c) => c.id)).toEqual(['c1'])

    const both = filterByLabels(b, new Set(['l1', 'l2']))
    expect(both.lists[0]!.cards.map((c) => c.id)).toEqual(['c1', 'c2'])
  })

  it('hides EVERY card when the only active id matches none (the bug pruning prevents)', () => {
    const b = makeBoard([makeCard('c1', ['l1']), makeCard('c2', ['l2'])])
    // Simulates a stale filter on a since-deleted label - this is the
    // empty-board state pruneLabelFilter exists to avoid.
    const out = filterByLabels(b, new Set(['gone']))
    expect(out.lists[0]!.cards).toEqual([])
  })
})

describe('pruneLabelFilter', () => {
  it('drops ids that no longer exist on the board', () => {
    const pruned = pruneLabelFilter(new Set(['l1', 'gone']), ['l1', 'l2'])
    expect([...pruned]).toEqual(['l1'])
  })

  it('clears the set entirely when the only active id was deleted', () => {
    const pruned = pruneLabelFilter(new Set(['gone']), ['l1', 'l2'])
    expect(pruned.size).toBe(0)
  })

  it('returns the SAME set reference when nothing was pruned (no re-render)', () => {
    const active = new Set(['l1', 'l2'])
    expect(pruneLabelFilter(active, ['l1', 'l2', 'l3'])).toBe(active)
  })

  it('passes an empty active set straight through', () => {
    const empty = new Set<string>()
    expect(pruneLabelFilter(empty, ['l1'])).toBe(empty)
  })
})
