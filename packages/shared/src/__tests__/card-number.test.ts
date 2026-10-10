import { describe, expect, it } from 'vitest'
import {
  fillMissingCardNumbers,
  formatCardNumber,
  parseCardNumberRef
} from '../card-number'

describe('parseCardNumberRef', () => {
  it('reads #N and bare N, ignoring surrounding space', () => {
    expect(parseCardNumberRef('#142')).toBe(142)
    expect(parseCardNumberRef('142')).toBe(142)
    expect(parseCardNumberRef('  #7 ')).toBe(7)
  })

  it('rejects anything that is not a positive whole number', () => {
    for (const s of ['', '#', '#0', '0', '-3', '#1.5', '12a', '# 12', '##12', 'abc']) {
      expect(parseCardNumberRef(s)).toBeNull()
    }
    // A UUIDv7 card id is never mistaken for a number.
    expect(parseCardNumberRef('0190f1e2-7a3b-7c4d-8e5f-6a7b8c9d0e1f')).toBeNull()
    // Too long to be a real number (and past safe-integer range).
    expect(parseCardNumberRef('#12345678901234567890')).toBeNull()
  })
})

describe('formatCardNumber', () => {
  it('prefixes a hash', () => {
    expect(formatCardNumber(142)).toBe('#142')
  })
})

describe('fillMissingCardNumbers', () => {
  it('numbers cards without one in creation order, id breaking ties', () => {
    const got = fillMissingCardNumbers([
      { id: 'b', createdAt: 200 },
      { id: 'c', createdAt: 100 },
      { id: 'a', createdAt: 200 }
    ])
    expect(Object.fromEntries(got)).toEqual({ c: 1, a: 2, b: 3 })
  })

  it('keeps existing numbers and starts after the highest of them and the counter', () => {
    const got = fillMissingCardNumbers(
      [
        { id: 'x', createdAt: 1, number: 4 },
        { id: 'y', createdAt: 2, number: null },
        { id: 'z', createdAt: 3 }
      ],
      9
    )
    expect(Object.fromEntries(got)).toEqual({ x: 4, y: 10, z: 11 })
  })
})
