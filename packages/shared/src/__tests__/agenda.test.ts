import { describe, expect, it } from 'vitest'
import {
  AGENDA_DEFAULT_LIMIT,
  agendaWindows,
  buildAgendaView,
  localDayStart,
  type AgendaCandidate
} from '../agenda'
import { zAgendaRequest, zAgendaView } from '../views'

// buildAgendaView is the single owner of the agenda's section rules, so
// the live read (@kanbini/db getAgenda) and the MCP headless reader agree
// by construction. What we pin here:
//   • local-day windows (today is [00:00, next 00:00), DST-safe)
//   • open cards bucket by due date; no due date / past the window = out
//   • completed cards land in `completed` only when finished in-window
//   • due sections sort soonest -> most urgent -> id; completed newest first
//   • per-section limit trims the arrays but not `totals`

// A fixed local noon keeps every boundary unambiguous.
const NOW = new Date(2026, 8, 15, 12, 0, 0).getTime()
const DAY0 = new Date(2026, 8, 15).getTime()
const day = (offset: number): number => new Date(2026, 8, 15 + offset).getTime()

let seq = 0
function cand(over: Partial<AgendaCandidate> = {}): AgendaCandidate {
  seq += 1
  return {
    cardId: `c${String(seq).padStart(3, '0')}`,
    title: `Card ${seq}`,
    boardId: 'b1',
    boardName: 'Board',
    boardColor: null,
    listId: 'l1',
    listName: 'List',
    dueAt: null,
    priority: null,
    completedAt: null,
    completed: false,
    blocked: false,
    ...over
  }
}

describe('localDayStart / agendaWindows', () => {
  it('returns local midnight of the day containing ms', () => {
    expect(localDayStart(NOW)).toBe(DAY0)
    expect(localDayStart(DAY0)).toBe(DAY0)
    expect(localDayStart(DAY0 - 1)).toBe(day(-1))
  })

  it('offsets by calendar days', () => {
    expect(localDayStart(NOW, 1)).toBe(day(1))
    expect(localDayStart(NOW, -7)).toBe(day(-7))
  })

  it('builds today / upcoming / completed windows', () => {
    expect(agendaWindows(NOW, 7, 3)).toEqual({
      dayStart: DAY0,
      tomorrowStart: day(1),
      upcomingEnd: day(8),
      completedSince: day(-3)
    })
  })

  it('crosses month ends without drifting', () => {
    const lastOfMonth = new Date(2026, 0, 31, 9).getTime()
    expect(localDayStart(lastOfMonth, 1)).toBe(new Date(2026, 1, 1).getTime())
  })
})

describe('buildAgendaView', () => {
  it('buckets open cards by due date', () => {
    const overdue = cand({ dueAt: day(-2) })
    const lastNight = cand({ dueAt: DAY0 - 1 })
    const today = cand({ dueAt: DAY0 })
    const tonight = cand({ dueAt: day(1) - 1 })
    const tomorrow = cand({ dueAt: day(1) })
    const lastUpcoming = cand({ dueAt: day(8) - 1 })
    const tooFar = cand({ dueAt: day(8) })
    const noDue = cand()

    const v = buildAgendaView(
      [overdue, lastNight, today, tonight, tomorrow, lastUpcoming, tooFar, noDue],
      { now: NOW }
    )
    expect(v.dayStart).toBe(DAY0)
    expect(v.overdue.map((c) => c.cardId)).toEqual([overdue.cardId, lastNight.cardId])
    expect(v.today.map((c) => c.cardId)).toEqual([today.cardId, tonight.cardId])
    expect(v.upcoming.map((c) => c.cardId)).toEqual([
      tomorrow.cardId,
      lastUpcoming.cardId
    ])
    expect(v.completed).toEqual([])
  })

  it('honours a custom upcoming window', () => {
    const inTwo = cand({ dueAt: day(2) })
    const inThree = cand({ dueAt: day(3) })
    const v = buildAgendaView([inTwo, inThree], { now: NOW, upcomingDays: 2 })
    expect(v.upcomingDays).toBe(2)
    expect(v.upcoming.map((c) => c.cardId)).toEqual([inTwo.cardId])
  })

  it('puts completed cards in `completed` only when finished in-window', () => {
    const justNow = cand({ completed: true, completedAt: NOW - 1000, dueAt: day(-1) })
    const edge = cand({ completed: true, completedAt: day(-7) })
    const tooOld = cand({ completed: true, completedAt: day(-7) - 1 })
    const unknown = cand({ completed: true, completedAt: null, dueAt: DAY0 })

    const v = buildAgendaView([justNow, edge, tooOld, unknown], { now: NOW })
    expect(v.completed.map((c) => c.cardId)).toEqual([justNow.cardId, edge.cardId])
    // A completed card never shows as overdue / due, even with a due date.
    expect(v.overdue).toEqual([])
    expect(v.today).toEqual([])
  })

  it('passes `blocked` through for open cards and clears it once done', () => {
    const waiting = cand({ dueAt: DAY0, blocked: true })
    const done = cand({ completed: true, completedAt: NOW - 1000, blocked: true })
    const v = buildAgendaView([waiting, done], { now: NOW })
    expect(v.today[0]!.blocked).toBe(true)
    expect(v.completed[0]!.blocked).toBe(false)
  })

  it('never reports a completion time on an open card', () => {
    const reopened = cand({ dueAt: DAY0, completedAt: NOW - 5000 })
    const v = buildAgendaView([reopened], { now: NOW })
    expect(v.today[0]!.completedAt).toBeNull()
  })

  it('strips the internal `completed` flag from items', () => {
    const v = buildAgendaView([cand({ dueAt: DAY0 })], { now: NOW })
    expect(v.today[0]).not.toHaveProperty('completed')
    expect(() => zAgendaView.parse(v)).not.toThrow()
  })

  it('sorts due sections soonest -> most urgent -> id', () => {
    const low = cand({ cardId: 'a', dueAt: DAY0, priority: 'low' })
    const urgent = cand({ cardId: 'b', dueAt: DAY0, priority: 'urgent' })
    const none = cand({ cardId: 'c', dueAt: DAY0 })
    const high1 = cand({ cardId: 'e', dueAt: DAY0, priority: 'high' })
    const high2 = cand({ cardId: 'd', dueAt: DAY0, priority: 'high' })
    const earlierOverdue = cand({ cardId: 'z', dueAt: day(-3), priority: 'low' })
    const laterOverdue = cand({ cardId: 'y', dueAt: day(-1), priority: 'urgent' })

    const v = buildAgendaView(
      [low, urgent, none, high1, high2, laterOverdue, earlierOverdue],
      { now: NOW }
    )
    expect(v.today.map((c) => c.cardId)).toEqual(['b', 'd', 'e', 'a', 'c'])
    expect(v.overdue.map((c) => c.cardId)).toEqual(['z', 'y'])
  })

  it('sorts completed newest first, id descending on ties', () => {
    const older = cand({ cardId: 'a', completed: true, completedAt: NOW - 2000 })
    const newer = cand({ cardId: 'b', completed: true, completedAt: NOW - 1000 })
    const tieA = cand({ cardId: 'c', completed: true, completedAt: NOW - 3000 })
    const tieB = cand({ cardId: 'd', completed: true, completedAt: NOW - 3000 })
    const v = buildAgendaView([older, tieA, newer, tieB], { now: NOW })
    expect(v.completed.map((c) => c.cardId)).toEqual(['b', 'a', 'd', 'c'])
  })

  it('caps each section at `limit` but totals count everything', () => {
    const many = Array.from({ length: 5 }, () => cand({ dueAt: DAY0 }))
    const v = buildAgendaView(many, { now: NOW, limit: 2 })
    expect(v.today).toHaveLength(2)
    expect(v.totals).toEqual({ overdue: 0, today: 5, upcoming: 0, completed: 0 })
  })

  it('defaults to a week each way and the default limit', () => {
    const v = buildAgendaView([], { now: NOW })
    expect(v.upcomingDays).toBe(7)
    expect(v.completedDays).toBe(7)
    const many = Array.from({ length: AGENDA_DEFAULT_LIMIT + 3 }, () =>
      cand({ dueAt: day(-1) })
    )
    expect(buildAgendaView(many, { now: NOW }).overdue).toHaveLength(
      AGENDA_DEFAULT_LIMIT
    )
  })
})

describe('zAgendaRequest', () => {
  it('accepts an empty request', () => {
    expect(zAgendaRequest.parse({})).toEqual({})
  })

  it('rejects windows outside 1..60 days and a limit over 100', () => {
    expect(() => zAgendaRequest.parse({ upcomingDays: 0 })).toThrow()
    expect(() => zAgendaRequest.parse({ completedDays: 61 })).toThrow()
    expect(() => zAgendaRequest.parse({ limit: 101 })).toThrow()
    expect(zAgendaRequest.parse({ upcomingDays: 60, limit: 100 })).toEqual({
      upcomingDays: 60,
      limit: 100
    })
  })
})
