import { describe, expect, it } from 'vitest'
import {
  isCardHidden,
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
  it('offers 10, 20, 50, and all - the plan defaults', () => {
    expect(VISIBLE_LIMIT_OPTIONS).toEqual([10, 20, 50, null])
  })
})
