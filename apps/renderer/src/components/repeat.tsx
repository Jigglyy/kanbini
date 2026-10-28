import { useState } from 'react'
import { Repeat } from 'lucide-react'
import {
  REPEAT_PRESETS,
  describeRepeat,
  sameRepeat,
  type BoardView,
  type CardRepeat,
  type CardView,
  type Mutation
} from '@kanbini/shared'
import type { Optimistic } from '../hooks/useBoardMutation'
import { cn } from '../lib/utils'

// Repeating cards: the meta-row marker and the card-menu picker. The
// spawn itself (completing a repeating card adds the next one) happens
// server-side in the undo recorder, so the renderer only edits the rule.

type Apply = (m: Mutation, o: Optimistic) => void

const mapCard = (
  b: BoardView,
  id: string,
  fn: (c: CardView) => CardView
): BoardView => ({
  ...b,
  lists: b.lists.map((l) => ({
    ...l,
    cards: l.cards.map((c) => (c.id === id ? fn(c) : c))
  }))
})

/** Small marker beside the due date. `withText` spells the rule out (card
 *  detail header); the in-list card keeps just the icon + tooltip. */
export function RepeatBadge({
  card,
  withText = false
}: {
  card: CardView
  withText?: boolean
}) {
  if (!card.repeat) return null
  const text = describeRepeat(card.repeat)
  return (
    <span
      className="flex w-fit items-center gap-1 text-[11px] text-muted-foreground"
      title={`Repeats: ${text.toLowerCase()}`}
      aria-label={withText ? undefined : `Repeats ${text.toLowerCase()}`}
      role={withText ? undefined : 'img'}
    >
      <Repeat className="size-3.5" aria-hidden />
      {withText && text}
    </span>
  )
}

const PRESET_LABELS = ['Daily', 'Weekly', 'Every 2 weeks', 'Monthly', 'Yearly']

/** "a week", "2 weeks": how far apart the occurrences are. */
export function repeatSpan(rule: CardRepeat): string {
  return rule.every === 1 ? `a ${rule.unit}` : `${rule.every} ${rule.unit}s`
}

const UNITS: Array<{ value: CardRepeat['unit']; label: string }> = [
  { value: 'day', label: 'days' },
  { value: 'week', label: 'weeks' },
  { value: 'month', label: 'months' },
  { value: 'year', label: 'years' }
]

const chip =
  'rounded-md border px-2 py-0.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
const chipOn = 'border-primary/60 bg-accent text-foreground'
const chipOff = 'border-input text-muted-foreground hover:text-foreground'

/** Card-menu picker: Off, the presets, and a custom "every N units". */
export function RepeatPicker({
  card,
  apply,
  close
}: {
  card: CardView
  apply: Apply
  close: () => void
}) {
  const current = card.repeat
  const isPreset = REPEAT_PRESETS.some((p) => sameRepeat(p, current))
  const [custom, setCustom] = useState(false)
  const [every, setEvery] = useState(String(current?.every ?? 3))
  const [unit, setUnit] = useState<CardRepeat['unit']>(current?.unit ?? 'day')

  const set = (next: CardRepeat | null): void => {
    if (sameRepeat(next, current)) {
      close()
      return
    }
    apply(
      { type: 'card.update', id: card.id, patch: { repeat: next } },
      (b) => mapCard(b, card.id, (c) => ({ ...c, repeat: next }))
    )
    close()
  }

  const n = Number(every)
  const customValid = Number.isInteger(n) && n >= 1 && n <= 99

  return (
    <>
      <div className="flex flex-wrap gap-1 px-2 py-1" role="group" aria-label="Repeat">
        <button
          type="button"
          aria-pressed={current === null}
          onClick={() => set(null)}
          className={cn(chip, current === null ? chipOn : chipOff)}
        >
          Off
        </button>
        {REPEAT_PRESETS.map((p, i) => {
          const on = sameRepeat(p, current)
          return (
            <button
              key={PRESET_LABELS[i]}
              type="button"
              aria-pressed={on}
              onClick={() => set(p)}
              className={cn(chip, on ? chipOn : chipOff)}
            >
              {PRESET_LABELS[i]}
            </button>
          )
        })}
        {current && !isPreset && (
          <button type="button" aria-pressed className={cn(chip, chipOn)} onClick={() => setCustom(true)}>
            {describeRepeat(current)}
          </button>
        )}
        {!custom && (
          <button
            type="button"
            onClick={() => setCustom(true)}
            className={cn(chip, chipOff)}
          >
            Custom…
          </button>
        )}
      </div>
      {custom && (
        <form
          className="flex items-center gap-1.5 px-2 py-1 text-xs"
          onSubmit={(e) => {
            e.preventDefault()
            if (customValid) set({ unit, every: n })
          }}
        >
          <span className="text-muted-foreground">Every</span>
          <input
            type="number"
            min={1}
            max={99}
            value={every}
            onChange={(e) => setEvery(e.target.value)}
            aria-label="Repeat every"
            autoFocus
            className="w-14 rounded border border-input bg-background px-1.5 py-0.5 text-sm focus:border-ring focus:outline-none"
          />
          <select
            value={unit}
            onChange={(e) => setUnit(e.target.value as CardRepeat['unit'])}
            aria-label="Repeat unit"
            className="rounded border border-input bg-background px-1 py-0.5 text-sm text-foreground focus:border-ring focus:outline-none"
          >
            {UNITS.map((u) => (
              <option key={u.value} value={u.value}>
                {u.label}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={!customValid}
            className="rounded bg-primary px-2 py-0.5 text-xs text-primary-foreground disabled:opacity-50"
          >
            Set
          </button>
        </form>
      )}
      {current && (
        <p className="px-2 pb-1 text-[11px] text-muted-foreground">
          Completing it adds the next one, due {repeatSpan(current)} later.
        </p>
      )}
    </>
  )
}
