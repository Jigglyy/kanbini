import { describe, expect, it } from 'vitest'
import { agendaWhen, calendarDaysFrom } from '../agenda'

// The "when" hint on each agenda row. Local-time fixtures (new Date(y,
// m, d)) so the day math lines up with the runner's timezone the same
// way it does with the user's.

const DAY0 = new Date(2026, 8, 15).getTime() // Tue Sep 15 2026, 00:00
const NOW = new Date(2026, 8, 15, 15, 0).getTime()
const at = (dayOffset: number, hour = 0, min = 0): number =>
  new Date(2026, 8, 15 + dayOffset, hour, min).getTime()
const item = (over: { dueAt?: number | null; completedAt?: number | null }) => ({
  dueAt: null,
  completedAt: null,
  ...over
})

describe('calendarDaysFrom', () => {
  it('counts local calendar days, ignoring the time of day', () => {
    expect(calendarDaysFrom(DAY0, at(0, 23, 59))).toBe(0)
    expect(calendarDaysFrom(DAY0, at(1))).toBe(1)
    expect(calendarDaysFrom(DAY0, at(-3, 12))).toBe(-3)
  })
})

describe('agendaWhen', () => {
  it('overdue: relative days in the past', () => {
    expect(agendaWhen('overdue', item({ dueAt: at(-1) }), DAY0, NOW, 'en-US')).toBe(
      'yesterday'
    )
    expect(agendaWhen('overdue', item({ dueAt: at(-4) }), DAY0, NOW, 'en-US')).toBe(
      '4 days ago'
    )
  })

  it('today: no hint (the heading says it)', () => {
    expect(agendaWhen('today', item({ dueAt: DAY0 }), DAY0, NOW, 'en-US')).toBe('')
  })

  it('upcoming: "tomorrow", then weekday + date', () => {
    expect(agendaWhen('upcoming', item({ dueAt: at(1) }), DAY0, NOW, 'en-US')).toBe(
      'tomorrow'
    )
    expect(agendaWhen('upcoming', item({ dueAt: at(3) }), DAY0, NOW, 'en-US')).toBe(
      'Fri, Sep 18'
    )
  })

  it('completed: minutes, then hours today, then days', () => {
    expect(
      agendaWhen('completed', item({ completedAt: NOW - 20_000 }), DAY0, NOW, 'en-US')
    ).toBe('now')
    expect(
      agendaWhen('completed', item({ completedAt: NOW - 5 * 60_000 }), DAY0, NOW, 'en-US')
    ).toBe('5 minutes ago')
    expect(
      agendaWhen('completed', item({ completedAt: at(0, 9) }), DAY0, NOW, 'en-US')
    ).toBe('6 hours ago')
    expect(
      agendaWhen('completed', item({ completedAt: at(-1, 22) }), DAY0, NOW, 'en-US')
    ).toBe('yesterday')
    expect(
      agendaWhen('completed', item({ completedAt: at(-3, 10) }), DAY0, NOW, 'en-US')
    ).toBe('3 days ago')
  })

  it('returns "" when the relevant timestamp is missing', () => {
    expect(agendaWhen('overdue', item({}), DAY0, NOW, 'en-US')).toBe('')
    expect(agendaWhen('completed', item({}), DAY0, NOW, 'en-US')).toBe('')
  })
})
