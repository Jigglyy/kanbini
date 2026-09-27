import { describe, expect, it } from 'vitest'
import { advanceBy, describeRepeat, nextDueAt, sameRepeat } from '../repeat'
import { zCardRepeat } from '../views'

// Local-time fixtures, matching how due dates are stored (local midnight).
const at = (y: number, m: number, d: number): number => new Date(y, m - 1, d).getTime()
const NOW = new Date(2026, 8, 15, 14, 30).getTime() // Tue Sep 15 2026, afternoon

describe('advanceBy', () => {
  it('steps days and weeks', () => {
    expect(advanceBy(at(2026, 9, 15), { unit: 'day', every: 1 })).toBe(at(2026, 9, 16))
    expect(advanceBy(at(2026, 9, 15), { unit: 'week', every: 2 })).toBe(at(2026, 9, 29))
    expect(advanceBy(at(2026, 9, 15), { unit: 'day', every: 3 }, 2)).toBe(at(2026, 9, 21))
  })

  it('crosses month and year ends', () => {
    expect(advanceBy(at(2026, 12, 30), { unit: 'day', every: 3 })).toBe(at(2027, 1, 2))
    expect(advanceBy(at(2026, 11, 15), { unit: 'month', every: 2 })).toBe(at(2027, 1, 15))
  })

  it('clamps a month step to the last real day', () => {
    expect(advanceBy(at(2026, 1, 31), { unit: 'month', every: 1 })).toBe(at(2026, 2, 28))
    expect(advanceBy(at(2028, 1, 31), { unit: 'month', every: 1 })).toBe(at(2028, 2, 29))
    expect(advanceBy(at(2026, 1, 31), { unit: 'month', every: 1 }, 2)).toBe(at(2026, 3, 31))
  })

  it('clamps Feb 29 to Feb 28 in a common year', () => {
    expect(advanceBy(at(2028, 2, 29), { unit: 'year', every: 1 })).toBe(at(2029, 2, 28))
    expect(advanceBy(at(2028, 2, 29), { unit: 'year', every: 4 })).toBe(at(2032, 2, 29))
  })
})

describe('nextDueAt', () => {
  const weekly = { unit: 'week', every: 1 } as const

  it('keeps the schedule when finished on time or early', () => {
    expect(nextDueAt(at(2026, 9, 15), weekly, NOW)).toBe(at(2026, 9, 22))
    expect(nextDueAt(at(2026, 9, 18), weekly, NOW)).toBe(at(2026, 9, 25))
  })

  it('skips missed occurrences so the next one is in the future', () => {
    expect(nextDueAt(at(2026, 9, 1), weekly, NOW)).toBe(at(2026, 9, 22))
    expect(nextDueAt(at(2026, 9, 8), { unit: 'day', every: 1 }, NOW)).toBe(at(2026, 9, 16))
  })

  it('never lands on today', () => {
    // Due yesterday, daily: today is not "next", tomorrow is.
    expect(nextDueAt(at(2026, 9, 14), { unit: 'day', every: 1 }, NOW)).toBe(at(2026, 9, 16))
  })

  it('counts from today when the card had no due date', () => {
    expect(nextDueAt(null, weekly, NOW)).toBe(at(2026, 9, 22))
    expect(nextDueAt(null, { unit: 'month', every: 1 }, NOW)).toBe(at(2026, 10, 15))
  })
})

describe('describeRepeat / sameRepeat / zCardRepeat', () => {
  it('reads naturally', () => {
    expect(describeRepeat({ unit: 'day', every: 1 })).toBe('Every day')
    expect(describeRepeat({ unit: 'week', every: 2 })).toBe('Every 2 weeks')
    expect(describeRepeat({ unit: 'year', every: 1 })).toBe('Every year')
  })

  it('compares rules by value', () => {
    expect(sameRepeat({ unit: 'week', every: 1 }, { unit: 'week', every: 1 })).toBe(true)
    expect(sameRepeat({ unit: 'week', every: 1 }, { unit: 'week', every: 2 })).toBe(false)
    expect(sameRepeat(null, null)).toBe(true)
    expect(sameRepeat(null, { unit: 'day', every: 1 })).toBe(false)
  })

  it('bounds the interval', () => {
    expect(() => zCardRepeat.parse({ unit: 'day', every: 0 })).toThrow()
    expect(() => zCardRepeat.parse({ unit: 'day', every: 100 })).toThrow()
    expect(() => zCardRepeat.parse({ unit: 'hour', every: 1 })).toThrow()
  })
})
