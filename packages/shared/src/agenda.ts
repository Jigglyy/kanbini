import type { AgendaItem, AgendaView, CardPriority } from './views'

// Cross-board agenda: the bucketing + ordering core, shared by the live
// read (`getAgenda` in @kanbini/db) and the MCP headless reader so the
// two can't drift. Each caller gathers candidate cards its own way (SQL
// vs. the export dump) and hands them to `buildAgendaView`, which owns
// every rule about which section a card lands in and in what order.
//
// Days are LOCAL calendar days. Due dates are stored as local midnight
// of the picked day (due-date.tsx), so "due today" is the half-open
// window [today 00:00, tomorrow 00:00). Window edges are built with the
// Date constructor rather than `+ 86_400_000` so a DST switch doesn't
// shift a boundary by an hour.

export const AGENDA_DEFAULT_UPCOMING_DAYS = 7
export const AGENDA_DEFAULT_COMPLETED_DAYS = 7
export const AGENDA_DEFAULT_LIMIT = 50

/** Activity types that mean "this card just became complete". The
 *  newest one per card is its `completedAt`. */
export const AGENDA_COMPLETION_ACTIVITY_TYPES = [
  'completed',
  'rule-completed'
] as const

/** A card the caller considers for the agenda. `completed` decides
 *  between the due sections and the completed one; `completedAt` is
 *  only read for completed cards. */
export interface AgendaCandidate extends AgendaItem {
  completed: boolean
}

export interface AgendaOptions {
  /** Defaults to Date.now(); tests pin it. */
  now?: number
  upcomingDays?: number
  completedDays?: number
  limit?: number
}

export interface AgendaWindows {
  /** Local midnight today. */
  dayStart: number
  /** Local midnight tomorrow (end of "today", start of "upcoming"). */
  tomorrowStart: number
  /** Exclusive end of "upcoming". */
  upcomingEnd: number
  /** Inclusive start of "recently completed". */
  completedSince: number
}

/** Local midnight `offsetDays` days from the day containing `ms`. */
export function localDayStart(ms: number, offsetDays = 0): number {
  const d = new Date(ms)
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + offsetDays
  ).getTime()
}

export function agendaWindows(
  now: number,
  upcomingDays: number,
  completedDays: number
): AgendaWindows {
  return {
    dayStart: localDayStart(now),
    tomorrowStart: localDayStart(now, 1),
    upcomingEnd: localDayStart(now, 1 + upcomingDays),
    completedSince: localDayStart(now, -completedDays)
  }
}

const PRIORITY_RANK: Record<CardPriority, number> = {
  urgent: 4,
  high: 3,
  medium: 2,
  low: 1
}
const rank = (p: CardPriority | null): number =>
  p === null ? 0 : PRIORITY_RANK[p]

// Code-unit compare (not localeCompare) so the tiebreak is identical in
// every runtime and matches SQLite's default BINARY collation.
const strcmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Due sections: soonest first, then most urgent, then id. */
function compareDue(a: AgendaItem, b: AgendaItem): number {
  const d = (a.dueAt ?? 0) - (b.dueAt ?? 0)
  if (d !== 0) return d
  const r = rank(b.priority) - rank(a.priority)
  if (r !== 0) return r
  return strcmp(a.cardId, b.cardId)
}

/** Completed section: most recently finished first, id as tiebreak. */
function compareCompleted(a: AgendaItem, b: AgendaItem): number {
  const d = (b.completedAt ?? 0) - (a.completedAt ?? 0)
  if (d !== 0) return d
  return strcmp(b.cardId, a.cardId)
}

const toItem = ({ completed: _completed, ...item }: AgendaCandidate): AgendaItem =>
  item

/** Sort `candidates` into the four agenda sections. Candidates that fit
 *  none (no due date, due beyond the window, completed too long ago or
 *  with no known completion time) are dropped, so a caller may pass a
 *  superset. */
export function buildAgendaView(
  candidates: readonly AgendaCandidate[],
  opts: AgendaOptions = {}
): AgendaView {
  const now = opts.now ?? Date.now()
  const upcomingDays = opts.upcomingDays ?? AGENDA_DEFAULT_UPCOMING_DAYS
  const completedDays = opts.completedDays ?? AGENDA_DEFAULT_COMPLETED_DAYS
  const limit = opts.limit ?? AGENDA_DEFAULT_LIMIT
  const w = agendaWindows(now, upcomingDays, completedDays)

  const overdue: AgendaItem[] = []
  const today: AgendaItem[] = []
  const upcoming: AgendaItem[] = []
  const completed: AgendaItem[] = []

  for (const c of candidates) {
    if (c.completed) {
      if (c.completedAt !== null && c.completedAt >= w.completedSince) {
        // Done is done: whatever it waited on no longer matters.
        completed.push({ ...toItem(c), blocked: false })
      }
      continue
    }
    if (c.dueAt === null) continue
    // Open cards never carry a completion time, whatever the caller sent.
    const item = { ...toItem(c), completedAt: null }
    if (c.dueAt < w.dayStart) overdue.push(item)
    else if (c.dueAt < w.tomorrowStart) today.push(item)
    else if (c.dueAt < w.upcomingEnd) upcoming.push(item)
  }

  overdue.sort(compareDue)
  today.sort(compareDue)
  upcoming.sort(compareDue)
  completed.sort(compareCompleted)

  return {
    dayStart: w.dayStart,
    upcomingDays,
    completedDays,
    overdue: overdue.slice(0, limit),
    today: today.slice(0, limit),
    upcoming: upcoming.slice(0, limit),
    completed: completed.slice(0, limit),
    totals: {
      overdue: overdue.length,
      today: today.length,
      upcoming: upcoming.length,
      completed: completed.length
    }
  }
}
