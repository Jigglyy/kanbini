import { localDayStart, type AgendaItem } from '@kanbini/shared'

// Pure helpers for the boards-home Agenda panel (components/agenda.tsx),
// kept here so the date wording is unit-testable without a DOM.

export type AgendaSection = 'overdue' | 'today' | 'upcoming' | 'completed'

/** Rows a section shows before its "Show N more" toggle. */
export const AGENDA_PREVIEW_COUNT = 5

const DAY_MS = 86_400_000

/** Whole local calendar days from `dayStart` to the day containing `ms`
 *  (negative = in the past). Rounded so a DST day (23 or 25 h) still
 *  counts as one. */
export function calendarDaysFrom(dayStart: number, ms: number): number {
  return Math.round((localDayStart(ms) - dayStart) / DAY_MS)
}

/** The short "when" hint on the right of an agenda row:
 *   overdue   -> "yesterday", "3 days ago"
 *   today     -> "" (the section heading already says it)
 *   upcoming  -> "tomorrow", then a weekday + date ("Tue, Sep 29")
 *   completed -> relative to now ("2 hours ago", "yesterday") */
export function agendaWhen(
  section: AgendaSection,
  item: Pick<AgendaItem, 'dueAt' | 'completedAt'>,
  dayStart: number,
  now: number = Date.now(),
  locale?: string
): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (section === 'completed') {
    if (item.completedAt == null) return ''
    const diff = item.completedAt - now
    const abs = Math.abs(diff)
    if (abs < 60_000) return rtf.format(0, 'second')
    if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute')
    const days = calendarDaysFrom(dayStart, item.completedAt)
    if (days === 0) return rtf.format(Math.round(diff / 3_600_000), 'hour')
    return rtf.format(days, 'day')
  }
  if (item.dueAt == null || section === 'today') return ''
  const days = calendarDaysFrom(dayStart, item.dueAt)
  if (section === 'overdue' || days === 1) return rtf.format(days, 'day')
  return new Date(item.dueAt).toLocaleDateString(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  })
}
