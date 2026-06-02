import { afterEach, describe, expect, it } from 'vitest'
import {
  applyLabelOrder,
  commitLabelOrder,
  loadLabelOrder,
  moveLabelInOrder,
  projectReorder,
  reorderLabels
} from '../label-order'

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

describe('projectReorder', () => {
  it('moves an id forward to the target slot (arrayMove semantics)', () => {
    expect(projectReorder(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual([
      'b',
      'c',
      'a',
      'd'
    ])
  })

  it('moves an id backward to the target slot', () => {
    expect(projectReorder(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual([
      'a',
      'd',
      'b',
      'c'
    ])
  })

  it('swaps two adjacent ids', () => {
    expect(projectReorder(['a', 'b', 'c'], 'b', 'a')).toEqual(['b', 'a', 'c'])
  })

  it('returns the SAME ref when active === over', () => {
    const ids = ['a', 'b', 'c']
    expect(projectReorder(ids, 'b', 'b')).toBe(ids)
  })

  it('returns the SAME ref when either id is missing', () => {
    const ids = ['a', 'b', 'c']
    expect(projectReorder(ids, 'zzz', 'b')).toBe(ids)
    expect(projectReorder(ids, 'a', 'zzz')).toBe(ids)
  })
})

describe('reorderLabels', () => {
  it('persists the projected order and returns it', () => {
    const out = reorderLabels('b1', ['a', 'b', 'c'], 'a', 'c')
    expect(out).toEqual(['b', 'c', 'a'])
    expect(loadLabelOrder('b1')).toEqual(['b', 'c', 'a'])
  })

  it('materializes the full creation order on the first drag', () => {
    // No saved order yet; dropping 'a' onto 'b' must persist every id so
    // the new order survives a reload (not just the moved pair).
    reorderLabels('b1', ['a', 'b', 'c', 'd'], 'a', 'b')
    expect(loadLabelOrder('b1')).toEqual(['b', 'a', 'c', 'd'])
  })

  it('is a no-op (writes nothing) when nothing moves', () => {
    const ids = ['a', 'b', 'c']
    expect(reorderLabels('b1', ids, 'b', 'b')).toBe(ids)
    expect(localStorage.getItem(KEY)).toBeNull()
  })
})

describe('commitLabelOrder', () => {
  it('persists an explicit final order verbatim (the live-drag result)', () => {
    commitLabelOrder('b1', ['c', 'a', 'b'])
    expect(loadLabelOrder('b1')).toEqual(['c', 'a', 'b'])
    // and it round-trips through applyLabelOrder on the next render
    expect(
      applyLabelOrder([L('a'), L('b'), L('c')], 'b1').map((l) => l.id)
    ).toEqual(['c', 'a', 'b'])
  })
})
