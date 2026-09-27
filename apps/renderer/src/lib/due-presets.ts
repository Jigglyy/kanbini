import { localDayStart } from '@kanbini/shared'

// Due-date shortcuts for the card menu (Today, Tomorrow, End of week,
// Next week, End of month) and the "week starts on" preference they
// depend on. Pure so the calendar maths is unit-testable. All results
// are local midnight, the same form the date input stores.

/** Settings value. `locale` follows the system's convention. */
export type WeekStart = 'locale' | 'monday' | 'sunday' | 'saturday'

/** Day index (Date#getDay numbering: 0 = Sunday ... 6 = Saturday). */
export type WeekDay = 0 | 1 | 2 | 3 | 4 | 5 | 6

const FIXED: Record<Exclude<WeekStart, 'locale'>, WeekDay> = {
  monday: 1,
  sunday: 0,
  saturday: 6
}

/** The locale's first day of the week, via Intl week info when the
 *  runtime has it (Chromium does, as `getWeekInfo()`; older builds
 *  exposed a `weekInfo` getter). Monday when it can't tell. */
export function localeWeekStart(locale?: string): WeekDay {
  try {
    const loc = new Intl.Locale(locale ?? navigator.language) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number }
      weekInfo?: { firstDay: number }
    }
    const firstDay = loc.getWeekInfo?.().firstDay ?? loc.weekInfo?.firstDay
    // Intl numbers days 1 (Monday) .. 7 (Sunday).
    if (typeof firstDay === 'number' && firstDay >= 1 && firstDay <= 7) {
      return (firstDay % 7) as WeekDay
    }
  } catch {
    /* unknown locale tag - fall through */
  }
  return 1
}

export function resolveWeekStart(setting: WeekStart, locale?: string): WeekDay {
  return setting === 'locale' ? localeWeekStart(locale) : FIXED[setting]
}

export type DuePresetId = 'today' | 'tomorrow' | 'end-of-week' | 'next-week' | 'end-of-month'

export interface DuePreset {
  id: DuePresetId
  label: string
  at: number
}

/** The presets for "now", with the week starting on `weekStart`.
 *  End of week is the week's last day (today, if today is that day);
 *  Next week is the first day of the following week. */
export function duePresets(now: number, weekStart: WeekDay): DuePreset[] {
  const today = localDayStart(now)
  const dow = new Date(today).getDay()
  const intoWeek = (dow - weekStart + 7) % 7
  const d = new Date(today)
  return [
    { id: 'today', label: 'Today', at: today },
    { id: 'tomorrow', label: 'Tomorrow', at: localDayStart(now, 1) },
    { id: 'end-of-week', label: 'End of week', at: localDayStart(now, 6 - intoWeek) },
    { id: 'next-week', label: 'Next week', at: localDayStart(now, 7 - intoWeek) },
    {
      id: 'end-of-month',
      label: 'End of month',
      at: new Date(d.getFullYear(), d.getMonth() + 1, 0).getTime()
    }
  ]
}

/** How a due date reads on a card: "Today" / "Tomorrow" / "Yesterday"
 *  for the nearest days, otherwise a short date. */
export function dueLabel(dueAt: number, now: number = Date.now(), locale?: string): string {
  const diff = Math.round((localDayStart(dueAt) - localDayStart(now)) / 86_400_000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff === -1) return 'Yesterday'
  return new Date(dueAt).toLocaleDateString(locale, { month: 'short', day: 'numeric' })
}

/** Overdue means the due DAY has passed: a card due today is on time
 *  until midnight, not late from the first minute of the day. */
export const isOverdue = (dueAt: number, now: number = Date.now()): boolean =>
  dueAt < localDayStart(now)
