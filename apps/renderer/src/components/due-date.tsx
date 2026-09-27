import { CalendarClock } from 'lucide-react'
import type { BoardView, CardView, Mutation } from '@kanbini/shared'
import type { Optimistic } from '../hooks/useBoardMutation'
import { dueLabel, duePresets, isOverdue, resolveWeekStart } from '../lib/due-presets'
import { useSettings } from '../lib/settings'

// dueAt is epoch ms (schema v1); we store local midnight of the picked
// day. Display = DueBadge (on the card); editing = DueEditor (inside
// the card context menu).

type Apply = (m: Mutation, o: Optimistic) => void

const pad = (n: number): string => String(n).padStart(2, '0')

export function toInputValue(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function fromInputValue(v: string): number {
  const p = v.split('-').map(Number)
  return new Date(p[0] ?? 1970, (p[1] ?? 1) - 1, p[2] ?? 1).getTime()
}

export const patchDue = (
  b: BoardView,
  cardId: string,
  dueAt: number | null
): BoardView => ({
  ...b,
  lists: b.lists.map((l) => ({
    ...l,
    cards: l.cards.map((c) => (c.id === cardId ? { ...c, dueAt } : c))
  }))
})

/** Read-only chip shown on the card when a due date is set. */
export function DueBadge({ card }: { card: CardView }) {
  if (card.dueAt == null) return null
  // Late once the due DAY is over; a card due today isn't overdue yet.
  const overdue = !card.completed && isOverdue(card.dueAt)
  return (
    <span
      className={`flex w-fit items-center gap-1 rounded px-1 text-[11px] ${
        overdue ? 'text-danger' : 'text-muted-foreground'
      }`}
      title={`Due ${new Date(card.dueAt).toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric'
      })}${overdue ? ' (overdue)' : ''}`}
    >
      <CalendarClock className="size-3.5" />
      {dueLabel(card.dueAt)}
    </span>
  )
}

/** Date input + clear, for the card context menu. */
export function DueEditor({
  card,
  apply,
  close
}: {
  card: CardView
  apply: Apply
  close: () => void
}) {
  const [settings] = useSettings()
  const presets = duePresets(Date.now(), resolveWeekStart(settings.weekStart))
  const set = (dueAt: number | null): void => {
    if (dueAt === card.dueAt) {
      close()
      return
    }
    apply({ type: 'card.update', id: card.id, patch: { dueAt } }, (b) =>
      patchDue(b, card.id, dueAt)
    )
    close()
  }
  return (
    <>
    <div className="flex flex-wrap gap-1 px-2 pt-1" role="group" aria-label="Due date shortcuts">
      {presets.map((p) => {
        const on = card.dueAt === p.at
        return (
          <button
            key={p.id}
            type="button"
            aria-pressed={on}
            title={new Date(p.at).toLocaleDateString(undefined, {
              weekday: 'short',
              month: 'short',
              day: 'numeric'
            })}
            onClick={() => set(p.at)}
            className={`rounded-md border px-2 py-0.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              on
                ? 'border-primary/60 bg-accent text-foreground'
                : 'border-input text-muted-foreground hover:text-foreground'
            }`}
          >
            {p.label}
          </button>
        )
      })}
    </div>
    <div className="flex items-center gap-2 px-2 py-1">
      <input
        type="date"
        defaultValue={card.dueAt != null ? toInputValue(card.dueAt) : ''}
        onChange={(e) => e.target.value && set(fromInputValue(e.target.value))}
        className="flex-1 rounded border border-border bg-background px-2 py-1 text-sm focus:border-ring focus:outline-none"
      />
      {card.dueAt != null && (
        <button
          onClick={() => set(null)}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Clear
        </button>
      )}
    </div>
    </>
  )
}
