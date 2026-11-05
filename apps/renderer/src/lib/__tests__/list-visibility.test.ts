import { describe, expect, it } from 'vitest'
import {
  effectiveCardLimit,
  isCardHidden,
  limitCardCount,
  listFooterState,
  resolveTruncatedDrop,
  visibleCards,
  VISIBLE_LIMIT_OPTIONS
} from '../list-visibility'

// "Show first N" rules. The limit only decides what's mounted; these pin
// that a hidden card is never unreachable and that a drop never makes
// some other card vanish from view.

const cards = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}` }))
const ids = (xs: Array<{ id: string }>) => xs.map((c) => c.id)
const NONE: ReadonlySet<string> = new Set()

describe('visibleCards', () => {
  it('shows everything with no limit, when revealed, or when under the limit', () => {
    expect(visibleCards(cards(5), null, false, NONE)).toEqual({
      shown: cards(5),
      hiddenCount: 0
    })
    expect(visibleCards(cards(30), 10, true, NONE).hiddenCount).toBe(0)
    expect(visibleCards(cards(10), 10, false, NONE).hiddenCount).toBe(0)
  })

  it('shows the first N and counts the rest', () => {
    const v = visibleCards(cards(30), 10, false, NONE)
    expect(ids(v.shown)).toEqual(ids(cards(10)))
    expect(v.hiddenCount).toBe(20)
  })

  it('always shows a pinned card, without it using one of the N slots', () => {
    // c15 was moved in this session: it shows, AND the first 10 still do.
    const v = visibleCards(cards(30), 10, false, new Set(['c15']))
    expect(ids(v.shown)).toEqual([...ids(cards(10)), 'c15'])
    expect(v.hiddenCount).toBe(19)
  })

  it('a pinned card inside the first N frees a slot for the next card', () => {
    // A card dropped at position 3 must not push c10 out of view.
    const v = visibleCards(cards(30), 10, false, new Set(['c3']))
    expect(ids(v.shown)).toEqual([...ids(cards(11))])
    expect(v.hiddenCount).toBe(19)
  })

  it('treats the card being dragged as pinned', () => {
    const v = visibleCards(cards(30), 10, false, NONE, 'c20')
    expect(ids(v.shown)).toContain('c20')
    expect(v.shown).toHaveLength(11)
  })
})

describe('isCardHidden', () => {
  it('is true only for a card past the limit that nothing pins', () => {
    expect(isCardHidden(cards(30), 'c11', 10, false, NONE)).toBe(true)
    expect(isCardHidden(cards(30), 'c10', 10, false, NONE)).toBe(false)
    expect(isCardHidden(cards(30), 'c11', 10, true, NONE)).toBe(false)
    expect(isCardHidden(cards(30), 'c11', 10, false, new Set(['c11']))).toBe(false)
    expect(isCardHidden(cards(30), 'c11', null, false, NONE)).toBe(false)
  })

  it('is false for a card that is not in the list at all', () => {
    expect(isCardHidden(cards(30), 'nope', 10, false, NONE)).toBe(false)
  })
})

describe('resolveTruncatedDrop', () => {
  const shownOf = (listId: string) =>
    listId === 'long' ? ['c1', 'c2', 'c3'] : null

  it('aims a drop on a truncated list just below its last visible card', () => {
    expect(resolveTruncatedDrop('list:long', 'before', 'x', shownOf)).toEqual({
      overId: 'c3',
      position: 'after'
    })
  })

  it('skips the dragged card itself when it is the last one shown', () => {
    expect(resolveTruncatedDrop('list:long', 'after', 'c3', shownOf)).toEqual({
      overId: 'c2',
      position: 'after'
    })
  })

  it('passes a card target, or a list that hides nothing, through', () => {
    expect(resolveTruncatedDrop('c2', 'before', 'x', shownOf)).toEqual({
      overId: 'c2',
      position: 'before'
    })
    expect(resolveTruncatedDrop('list:short', 'after', 'x', shownOf)).toEqual({
      overId: 'list:short',
      position: 'after'
    })
  })
})

describe('VISIBLE_LIMIT_OPTIONS', () => {
  it('offers automatic, 10, 20, 50, and always-all', () => {
    expect(VISIBLE_LIMIT_OPTIONS).toEqual([null, 10, 20, 50, 0])
  })
})

describe('effectiveCardLimit', () => {
  it('shortens a list of more than 30 cards to 20 when it has no limit of its own', () => {
    expect(effectiveCardLimit(null, 30, true)).toBeNull()
    expect(effectiveCardLimit(null, 31, true)).toBe(20)
    expect(effectiveCardLimit(null, 252, true)).toBe(20)
  })

  it("leaves long lists alone when the setting is off", () => {
    expect(effectiveCardLimit(null, 252, false)).toBeNull()
  })

  it("a list's own choice always wins", () => {
    expect(effectiveCardLimit(10, 5, true)).toBe(10)
    expect(effectiveCardLimit(50, 252, true)).toBe(50)
    expect(effectiveCardLimit(10, 252, false)).toBe(10)
    // "All" (0) keeps even a long list fully open.
    expect(effectiveCardLimit(0, 252, true)).toBeNull()
  })
})

describe('limitCardCount', () => {
  const list = cards(5)
  it('is the plain count with no drag in flight', () => {
    expect(limitCardCount(list, 'L', null, null)).toBe(5)
  })

  it('counts each list as it was at pickup while a card crosses lists', () => {
    // The card has left the source (live reorder) - still counted there.
    expect(limitCardCount(list, 'src', 'gone', 'src')).toBe(6)
    // It sits in the destination already - not counted there yet.
    expect(limitCardCount(list, 'dest', 'c3', 'src')).toBe(4)
    // A drag within one list changes nothing.
    expect(limitCardCount(list, 'src', 'c3', 'src')).toBe(5)
    // Lists the drag never touched.
    expect(limitCardCount(list, 'other', 'x', 'src')).toBe(5)
  })

  it('so a list on the threshold neither folds nor unfolds mid-drag', () => {
    const thirty = cards(30)
    const thirtyOne = [...thirty, { id: 'dragged' }]
    // Destination at 30 receiving the dragged card stays unshortened...
    expect(effectiveCardLimit(null, limitCardCount(thirtyOne, 'dest', 'dragged', 'src'), true)).toBeNull()
    // ...and a source at 31 losing it stays shortened.
    expect(effectiveCardLimit(null, limitCardCount(thirty, 'src', 'dragged', 'src'), true)).toBe(20)
  })
})

describe('listFooterState', () => {
  it('offers Show N more while cards are hidden', () => {
    expect(listFooterState(cards(30), 10, false, NONE)).toEqual({ kind: 'more', count: 20 })
  })

  it('offers Show fewer on a revealed list that would hide something', () => {
    expect(listFooterState(cards(30), 10, true, NONE)).toEqual({ kind: 'fewer' })
  })

  it('offers nothing when folding back would hide nothing (extra cards all pinned)', () => {
    // Limit 10, 11 cards, the 11th moved in (pinned): revealed or not,
    // every card shows - a Show fewer button would do nothing.
    expect(listFooterState(cards(11), 10, true, new Set(['c11']))).toBeNull()
    expect(listFooterState(cards(11), 10, false, new Set(['c11']))).toBeNull()
  })

  it('offers nothing without a limit or under it', () => {
    expect(listFooterState(cards(30), null, false, NONE)).toBeNull()
    expect(listFooterState(cards(5), 10, true, NONE)).toBeNull()
  })
})

describe('a card dragged within its own list', () => {
  it('keeps its slot, so picking it up reveals nothing (activeId only for incoming cards)', () => {
    // Board passes activeId ONLY to lists the card is entering. Within its
    // own list the call is the plain one - the same 10 cards as at rest.
    const atRest = visibleCards(cards(30), 10, false, NONE)
    expect(ids(atRest.shown)).toEqual(ids(cards(10)))
    // Had the card been treated as pinned here, c11 would have popped in.
    const wrongly = visibleCards(cards(30), 10, false, NONE, 'c1')
    expect(ids(wrongly.shown)).toContain('c11')
  })
})
