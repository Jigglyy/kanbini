import { describe, expect, it } from 'vitest'
import {
  dueLabel,
  duePresets,
  isOverdue,
  localeWeekStart,
  resolveWeekStart
} from '../due-presets'

// Wed Sep 16 2026, mid-afternoon (local).
const NOW = new Date(2026, 8, 16, 15, 0).getTime()
const day = (d: number, m = 9): number => new Date(2026, m - 1, d).getTime()
const at = (id: string, weekStart: 0 | 1 | 6) =>
  duePresets(NOW, weekStart).find((p) => p.id === id)!.at

describe('duePresets', () => {
  it('today and tomorrow are local midnights', () => {
    expect(at('today', 1)).toBe(day(16))
    expect(at('tomorrow', 1)).toBe(day(17))
  })

  it('follows the week start for end of week and next week', () => {
    // Monday-start week: Mon 14 .. Sun 20.
    expect(at('end-of-week', 1)).toBe(day(20))
    expect(at('next-week', 1)).toBe(day(21))
    // Sunday-start week: Sun 13 .. Sat 19.
    expect(at('end-of-week', 0)).toBe(day(19))
    expect(at('next-week', 0)).toBe(day(20))
    // Saturday-start week: Sat 12 .. Fri 18.
    expect(at('end-of-week', 6)).toBe(day(18))
    expect(at('next-week', 6)).toBe(day(19))
  })

  it('end of week is today on the last day of the week', () => {
    const sunday = new Date(2026, 8, 20, 9).getTime()
    expect(duePresets(sunday, 1).find((p) => p.id === 'end-of-week')!.at).toBe(day(20))
    expect(duePresets(sunday, 1).find((p) => p.id === 'next-week')!.at).toBe(day(21))
  })

  it('end of month is the last day of this month', () => {
    expect(at('end-of-month', 1)).toBe(day(30))
    const feb = new Date(2028, 1, 10).getTime()
    expect(duePresets(feb, 1).find((p) => p.id === 'end-of-month')!.at).toBe(
      new Date(2028, 1, 29).getTime()
    )
  })
})

describe('week start', () => {
  it('maps fixed choices to Date#getDay numbers', () => {
    expect(resolveWeekStart('monday')).toBe(1)
    expect(resolveWeekStart('sunday')).toBe(0)
    expect(resolveWeekStart('saturday')).toBe(6)
  })

  it('reads the locale convention, with Monday as the fallback', () => {
    // en-GB weeks start on Monday; an unusable tag falls back to Monday.
    expect(localeWeekStart('en-GB')).toBe(1)
    expect(localeWeekStart('not a locale')).toBe(1)
    expect([0, 1, 6]).toContain(localeWeekStart('en-US'))
  })
})

describe('dueLabel / isOverdue', () => {
  it('names the nearest days and dates the rest', () => {
    expect(dueLabel(day(16), NOW)).toBe('Today')
    expect(dueLabel(day(17), NOW)).toBe('Tomorrow')
    expect(dueLabel(day(15), NOW)).toBe('Yesterday')
    expect(dueLabel(day(25), NOW, 'en-US')).toBe('Sep 25')
  })

  it('is not overdue until the due day is over', () => {
    expect(isOverdue(day(16), NOW)).toBe(false)
    expect(isOverdue(day(15), NOW)).toBe(true)
    expect(isOverdue(day(17), NOW)).toBe(false)
  })
})
