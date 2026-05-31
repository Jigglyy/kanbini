import { afterEach, describe, expect, it } from 'vitest'
import { applyLabelOrder, loadLabelOrder, moveLabelInOrder } from '../label-order'

// Per-board manual label order (localStorage). Default = creation order
// (the DB returns labels that way), with an optional user reorder on top.

afterEach(() => localStorage.clear())

const L = (id: string) => ({ id, name: id })
const KEY = 'kanbini.labelOrder.b1'

describe('applyLabelOrder', () => {
  it('returns the labels unchanged (same ref) when nothing is saved', () => {
    const labels = [L('a'), L('b'), L('c')]
    expect(applyLabelOrder(labels, 'b1')).toBe(labels)
  })

  it('reorders by the saved order; unranked (new) labels keep creation order at the end', () => {
    localStorage.setItem(KEY, JSON.stringify(['c', 'a']))
    const out = applyLabelOrder([L('a'), L('b'), L('c'), L('d')], 'b1')
    expect(out.map((l) => l.id)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('ignores saved ids that no longer exist', () => {
    localStorage.setItem(KEY, JSON.stringify(['gone', 'b']))
    const out = applyLabelOrder([L('a'), L('b')], 'b1')
    expect(out.map((l) => l.id)).toEqual(['b', 'a'])
  })

  it('tolerates a corrupt stored value', () => {
    localStorage.setItem(KEY, '{not json')
    const labels = [L('a'), L('b')]
    expect(applyLabelOrder(labels, 'b1')).toBe(labels)
  })
})

describe('moveLabelInOrder', () => {
  it('moves right then left and persists the result', () => {
    const right = moveLabelInOrder('b1', ['a', 'b', 'c'], 'a', 1)
    expect(right).toEqual(['b', 'a', 'c'])
    expect(loadLabelOrder('b1')).toEqual(['b', 'a', 'c'])
    expect(moveLabelInOrder('b1', right, 'a', -1)).toEqual(['a', 'b', 'c'])
  })

  it('is a no-op at the edges (and persists nothing)', () => {
    const ids = ['a', 'b', 'c']
    expect(moveLabelInOrder('b1', ids, 'a', -1)).toBe(ids)
    expect(moveLabelInOrder('b1', ids, 'c', 1)).toBe(ids)
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('is a no-op for an id not in the list', () => {
    const ids = ['a', 'b']
    expect(moveLabelInOrder('b1', ids, 'zzz', 1)).toBe(ids)
  })
})
