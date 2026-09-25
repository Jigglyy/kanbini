import { describe, expect, it } from 'vitest'
import type { BoardView, CardView } from '@kanbini/shared'
import {
  checklistProgress,
  collapseToggle,
  collapsedFor,
  isCardCompact,
  toggledCollapsed,
  withCardCollapsed
} from '../card-density'
import { ACTION_REGISTRY } from '../shortcuts'

// Pure helpers behind collapsible cards. The stored model is three-state
// on the card (null = follow the list) plus a default on the list; these
// pin the resolution rule and that toggling only ever stores an override
// when the card DIFFERS from its list.

describe('isCardCompact', () => {
  it('follows the list when the card has no opinion', () => {
    expect(isCardCompact(null, null)).toBe(false)
    expect(isCardCompact(null, 'compact')).toBe(true)
  })

  it("lets the card's own choice win either way", () => {
    expect(isCardCompact(true, null)).toBe(true)
    expect(isCardCompact(false, 'compact')).toBe(false)
    expect(isCardCompact(true, 'compact')).toBe(true)
    expect(isCardCompact(false, null)).toBe(false)
  })
})

describe('collapsedFor', () => {
  it('stores nothing when the card matches its list', () => {
    expect(collapsedFor(false, null)).toBeNull()
    expect(collapsedFor(true, 'compact')).toBeNull()
  })

  it('stores an override only when it differs', () => {
    expect(collapsedFor(true, null)).toBe(true)
    expect(collapsedFor(false, 'compact')).toBe(false)
  })
})

describe('toggledCollapsed', () => {
  it('flips what the card shows, in every starting state', () => {
    for (const density of [null, 'compact'] as const) {
      for (const collapsed of [null, true, false] as const) {
        const before = isCardCompact(collapsed, density)
        const next = toggledCollapsed(collapsed, density)
        expect(isCardCompact(next, density)).toBe(!before)
      }
    }
  })

  it('toggling twice lands back on "follow the list"', () => {
    for (const density of [null, 'compact'] as const) {
      const once = toggledCollapsed(null, density)
      expect(toggledCollapsed(once, density)).toBeNull()
    }
  })
})

function card(id: string, overrides: Partial<CardView> = {}): CardView {
  return {
    id,
    title: id,
    description: null,
    position: 'a',
    completed: false,
    dueAt: null,
    priority: null,
    collapsed: null,
    labelIds: [],
    checklists: [],
    comments: [],
    attachments: [],
    coverAttachmentId: null,
    activities: [],
    ...overrides
  }
}

function board(): BoardView {
  const list = (id: string, cards: CardView[]) => ({
    id,
    name: id,
    color: null,
    closed: false,
    position: 'a',
    wipLimit: null,
    sortMode: null,
    onEnter: null,
    cardDensity: null,
    visibleCardLimit: null,
    cards
  })
  return {
    project: { id: 'p', name: 'P' },
    board: { id: 'b', name: 'B', color: null, background: null, swimlaneMode: null },
    labels: [],
    lists: [list('l1', [card('a'), card('b')]), list('l2', [card('c')])]
  }
}

describe('withCardCollapsed', () => {
  it('changes only the target card', () => {
    const b = board()
    const next = withCardCollapsed(b, 'b', true)
    expect(next.lists[0]!.cards.map((c) => c.collapsed)).toEqual([null, true])
    expect(next.lists[1]!.cards[0]!.collapsed).toBeNull()
  })

  it('leaves untouched lists referentially equal (memoised columns skip)', () => {
    const b = board()
    const next = withCardCollapsed(b, 'a', true)
    expect(next.lists[1]).toBe(b.lists[1])
    expect(next.lists[0]!.cards[1]).toBe(b.lists[0]!.cards[1])
  })
})

describe('checklistProgress', () => {
  const items = (flags: boolean[]) =>
    flags.map((completed, i) => ({ id: `i${i}`, text: 't', completed, position: 'a' }))

  it('is null for a card with no checklist items', () => {
    expect(checklistProgress(card('x'))).toBeNull()
    expect(
      checklistProgress(
        card('x', { checklists: [{ id: 'k', name: 'Empty', position: 'a', items: [] }] })
      )
    ).toBeNull()
  })

  it('sums done / total across every checklist', () => {
    const c = card('x', {
      checklists: [
        { id: 'k1', name: 'A', position: 'a', items: items([true, false]) },
        { id: 'k2', name: 'B', position: 'b', items: items([true, true, false]) }
      ]
    })
    expect(checklistProgress(c)).toEqual({ done: 3, total: 5 })
  })
})

describe('card.toggleCollapse shortcut', () => {
  it('is registered on m, which no other action uses by default', () => {
    const def = ACTION_REGISTRY.find((a) => a.id === 'card.toggleCollapse')
    expect(def?.defaults).toEqual([{ key: 'm' }])
    const others = ACTION_REGISTRY.filter((a) => a.id !== 'card.toggleCollapse')
    const clash = others.some((a) =>
      a.defaults.some((b) => b.key === 'm' && !b.ctrl && !b.meta && !b.alt && !b.shift)
    )
    expect(clash).toBe(false)
  })
})

describe('collapseToggle', () => {
  it('builds the mutation and a matching optimistic projection', () => {
    const b = board()
    const t = collapseToggle({ id: 'a', collapsed: null }, null)
    expect(t.mutation).toEqual({ type: 'card.update', id: 'a', patch: { collapsed: true } })
    expect(t.optimistic(b).lists[0]!.cards[0]!.collapsed).toBe(true)
  })

  it('in a compact list, expanding stores false and collapsing back stores null', () => {
    expect(collapseToggle({ id: 'a', collapsed: null }, 'compact').mutation.patch).toEqual({
      collapsed: false
    })
    expect(collapseToggle({ id: 'a', collapsed: false }, 'compact').mutation.patch).toEqual({
      collapsed: null
    })
  })
})
