import { describe, expect, it } from 'vitest'
import {
  firstOrderKey,
  orderKeyBetween,
  orderKeysBetween
} from '../order'

// Fractional-index ordering (ADR-0011). The library is well-tested
// upstream; these specs cover the behaviour Kanbini relies on so a
// future swap (or upstream bug) gets caught here.

describe('firstOrderKey', () => {
  it('returns a non-empty string', () => {
    const k = firstOrderKey()
    expect(typeof k).toBe('string')
    expect(k.length).toBeGreaterThan(0)
  })
})

describe('orderKeyBetween', () => {
  it('places a key strictly between two existing keys', () => {
    const a = firstOrderKey()
    const c = orderKeyBetween(a, null)
    const b = orderKeyBetween(a, c)
    expect(b > a).toBe(true)
    expect(b < c).toBe(true)
  })

  it('places a key after the last when right end is null', () => {
    const a = firstOrderKey()
    const next = orderKeyBetween(a, null)
    expect(next > a).toBe(true)
  })

  it('places a key before the first when left end is null', () => {
    const a = firstOrderKey()
    const before = orderKeyBetween(null, a)
    expect(before < a).toBe(true)
  })

  it('supports repeated subdivision between the same pair', () => {
    // The fractional-index scheme has to keep producing distinct keys
    // between two neighbours forever (drag this card here, then drag
    // another here, ad infinitum). Subdivide 50 times and assert every
    // key remained distinct + ordered.
    const a = firstOrderKey()
    const z = orderKeyBetween(a, null)
    const between: string[] = []
    let left = a
    for (let i = 0; i < 50; i++) {
      const mid = orderKeyBetween(left, z)
      between.push(mid)
      left = mid
    }
    expect(new Set(between).size).toBe(50)
    const sorted = [...between].sort()
    expect(sorted).toEqual(between)
    expect(sorted[0]! > a).toBe(true)
    expect(sorted.at(-1)! < z).toBe(true)
  })
})

describe('orderKeysBetween', () => {
  it('returns N strictly-ordered keys between two bounds', () => {
    const a = firstOrderKey()
    const z = orderKeyBetween(a, null)
    const keys = orderKeysBetween(a, z, 5)
    expect(keys).toHaveLength(5)
    expect([...keys].sort()).toEqual(keys)
    expect(keys[0]! > a).toBe(true)
    expect(keys.at(-1)! < z).toBe(true)
  })

  it('returns N keys when both bounds are null (empty list bulk insert)', () => {
    const keys = orderKeysBetween(null, null, 3)
    expect(keys).toHaveLength(3)
    expect([...keys].sort()).toEqual(keys)
  })
})
