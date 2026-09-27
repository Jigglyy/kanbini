import { localDayStart } from './agenda'
import type { CardRepeat } from './views'

// Repeating cards: the pure date rules, shared by the service layer
// (which spawns the next card) and the renderer (which labels the rule).
//
// Completing a repeating card creates the next one due `every` `unit`s
// after the old due date, on the same schedule. If that is still today
// or earlier (the card was finished late), it keeps stepping forward
// until the date is in the future, so a daily chore finished a week late
// comes back tomorrow, not seven times overdue. A card with no due date
// gets one: `every` `unit`s from today.
//
// Months and years clamp to the last day that exists (Jan 31 + 1 month
// = Feb 28/29; Feb 29 + 1 year = Feb 28). The clamped day then becomes
// the new anchor, so a card due on the 31st drifts to the 28th after
// February. Accepted for now; storing the original day of month would
// fix it.

/** `ms` moved on by `k` repeats of `rule`, in local time. */
export function advanceBy(ms: number, rule: CardRepeat, k = 1): number {
  const d = new Date(ms)
  const [y, mo, day] = [d.getFullYear(), d.getMonth(), d.getDate()]
  const time = [d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()] as const
  const n = rule.every * k
  switch (rule.unit) {
    case 'day':
      return new Date(y, mo, day + n, ...time).getTime()
    case 'week':
      return new Date(y, mo, day + 7 * n, ...time).getTime()
    case 'month': {
      const lastDay = new Date(y, mo + n + 1, 0).getDate()
      return new Date(y, mo + n, Math.min(day, lastDay), ...time).getTime()
    }
    case 'year': {
      const lastDay = new Date(y + n, mo + 1, 0).getDate()
      return new Date(y + n, mo, Math.min(day, lastDay), ...time).getTime()
    }
  }
}

/** Due date for the next occurrence of a card that was just completed.
 *  Always after today (local). */
export function nextDueAt(
  prevDueAt: number | null,
  rule: CardRepeat,
  now: number = Date.now()
): number {
  const tomorrow = localDayStart(now, 1)
  if (prevDueAt === null) return advanceBy(localDayStart(now), rule)
  // Bounded: even every-1-day from decades back is a few thousand steps.
  for (let k = 1; k <= 50_000; k++) {
    const next = advanceBy(prevDueAt, rule, k)
    if (next >= tomorrow) return next
  }
  return advanceBy(localDayStart(now), rule)
}

const UNIT_WORDS: Record<CardRepeat['unit'], [string, string]> = {
  day: ['day', 'days'],
  week: ['week', 'weeks'],
  month: ['month', 'months'],
  year: ['year', 'years']
}

/** "Every week", "Every 2 weeks". */
export function describeRepeat(rule: CardRepeat): string {
  const [one, many] = UNIT_WORDS[rule.unit]
  return rule.every === 1 ? `Every ${one}` : `Every ${rule.every} ${many}`
}

/** The picker's one-click choices. */
export const REPEAT_PRESETS: readonly CardRepeat[] = [
  { unit: 'day', every: 1 },
  { unit: 'week', every: 1 },
  { unit: 'week', every: 2 },
  { unit: 'month', every: 1 },
  { unit: 'year', every: 1 }
]

export const sameRepeat = (a: CardRepeat | null, b: CardRepeat | null): boolean =>
  a === b || (a !== null && b !== null && a.unit === b.unit && a.every === b.every)
