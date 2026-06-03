import { describe, expect, it } from 'vitest'
import {
  bulkCompleteTarget,
  bulkLabelAction,
  clickIntent,
  planMultiCardMove,
  rangeWithinList,
  toggleSelection
} from '../card-selection'

const mods = (over: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey', boolean>>) => ({
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...over
})

describe('clickIntent', () => {
  it('plain click opens', () => {
    expect(clickIntent(mods({}))).toBe('open')
  })
  it('ctrl or cmd click toggles', () => {
    expect(clickIntent(mods({ ctrlKey: true }))).toBe('toggle')
    expect(clickIntent(mods({ metaKey: true }))).toBe('toggle')
  })
  it('shift click range-selects', () => {
    expect(clickIntent(mods({ shiftKey: true }))).toBe('range')
  })
  it('ctrl wins over shift (toggle beats range)', () => {
    expect(clickIntent(mods({ ctrlKey: true, shiftKey: true }))).toBe('toggle')
  })
})

describe('toggleSelection', () => {
  it('adds an absent id and returns a new set', () => {
    const a = new Set<string>(['x'])
    const b = toggleSelection(a, 'y')
    expect([...b].sort()).toEqual(['x', 'y'])
    expect(b).not.toBe(a)
    expect(a.has('y')).toBe(false) // input untouched
  })
  it('removes a present id', () => {
    expect([...toggleSelection(new Set(['x', 'y']), 'x')]).toEqual(['y'])
  })
})

describe('rangeWithinList', () => {
  const ids = ['a', 'b', 'c', 'd', 'e']
  it('returns the inclusive span in forward order', () => {
    expect(rangeWithinList(ids, 'b', 'd')).toEqual(['b', 'c', 'd'])
  })
  it('handles a backwards selection', () => {
    expect(rangeWithinList(ids, 'd', 'b')).toEqual(['b', 'c', 'd'])
  })
  it('a single card is just itself', () => {
    expect(rangeWithinList(ids, 'c', 'c')).toEqual(['c'])
  })
  it('is empty when an id is not in the list (cross-list shift)', () => {
    expect(rangeWithinList(ids, 'b', 'zzz')).toEqual([])
    expect(rangeWithinList(ids, 'zzz', 'b')).toEqual([])
  })
})

describe('bulkCompleteTarget', () => {
  it('completes when any card is incomplete', () => {
    expect(
      bulkCompleteTarget([{ completed: true }, { completed: false }])
    ).toBe(true)
  })
  it('un-completes when every card is already complete', () => {
    expect(
      bulkCompleteTarget([{ completed: true }, { completed: true }])
    ).toBe(false)
  })
})

describe('planMultiCardMove', () => {
  const C = (...ids: string[]) => ids.map((id) => ({ id }))

  it('bounds the block by the nearest NON-selected neighbours', () => {
    // list: a b [LEAD=c] d e ; selection = c + e (e scattered below)
    const cards = C('a', 'b', 'c', 'd', 'e')
    const sel = new Set(['c', 'e'])
    const plan = planMultiCardMove(cards, 'c', sel, ['c', 'e'])
    // before = b (a/b not selected, b nearest), after = d (e is selected,
    // skipped -> d is the nearest non-selected after the lead)
    expect(plan).toEqual({ beforeId: 'b', afterId: 'd', orderedIds: ['c', 'e'] })
  })

  it('null neighbours at the list edges', () => {
    const cards = C('lead', 'x')
    const plan = planMultiCardMove(cards, 'lead', new Set(['lead']), ['lead'])
    expect(plan).toEqual({ beforeId: null, afterId: 'x', orderedIds: ['lead'] })
  })

  it('skips a contiguous run of selected cards above and below', () => {
    // a [s1] [LEAD] [s2] f ; all of s1,lead,s2 selected
    const cards = C('a', 's1', 'lead', 's2', 'f')
    const sel = new Set(['s1', 'lead', 's2'])
    const plan = planMultiCardMove(cards, 'lead', sel, ['s1', 'lead', 's2'])
    expect(plan).toEqual({
      beforeId: 'a',
      afterId: 'f',
      orderedIds: ['s1', 'lead', 's2']
    })
  })

  it('returns null when the lead is not in the list', () => {
    expect(planMultiCardMove(C('a', 'b'), 'zzz', new Set(), ['zzz'])).toBeNull()
  })
})

describe('bulkLabelAction', () => {
  const cards = [
    { id: 'a', labelIds: ['L1'] },
    { id: 'b', labelIds: [] },
    { id: 'c', labelIds: ['L1', 'L2'] }
  ]
  it('adds to the cards missing the label', () => {
    expect(bulkLabelAction(cards, 'L1')).toEqual({ add: true, targets: ['b'] })
  })
  it('removes from all when every card has the label', () => {
    expect(bulkLabelAction(cards, 'L2' /* only c */)).toEqual({
      add: true,
      targets: ['a', 'b']
    })
    const allHave = [
      { id: 'a', labelIds: ['L1'] },
      { id: 'b', labelIds: ['L1'] }
    ]
    expect(bulkLabelAction(allHave, 'L1')).toEqual({
      add: false,
      targets: ['a', 'b']
    })
  })
})
