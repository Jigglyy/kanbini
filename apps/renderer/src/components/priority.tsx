import { Flag } from 'lucide-react'
import type {
  BoardView,
  CardPriority,
  CardView,
  Mutation
} from '@kanbini/shared'
import type { Optimistic } from '../hooks/useBoardMutation'
import { MenuItem, MenuLabel } from './ui/context-menu'

// ADR-0037 · card priority field. Read-only badge on the in-list card
// preview + the card-detail header; editor surface lives in the card
// right-click menu. Stored as plain text on the card row; null =
// unprioritised (today's default - most cards).

type Apply = (m: Mutation, o: Optimistic) => void

interface PriorityMeta {
  label: string
  /** OKLCH colour for the priority flag. Deliberately a DIFFERENT
   *  colour world from `lib/palette.ts` ACCENTS (the label/list/board
   *  swatches): priorities are a muted cool-to-hot severity ramp
   *  (slate-blue low -> ochre -> orange -> deep red urgent), labels are
   *  vivid categorical hues. They used to share oklch strings outright
   *  (low == the slate label, medium == the amber label), which made a
   *  card with both read as "two of the same colour" - this ramp owns
   *  the low-chroma + darker "alert" zone the label palette stays out
   *  of, so the flag never collides with a label bar. */
  color: string
}

/** Display order (low → urgent) - the picker shows them in this order
 *  and the planned swimlanes view will too. */
export const PRIORITY_LEVELS: readonly CardPriority[] = [
  'low',
  'medium',
  'high',
  'urgent'
] as const

const META: Record<CardPriority, PriorityMeta> = {
  low: { label: 'Low', color: 'oklch(0.62 0.04 250)' }, // muted slate-blue
  medium: { label: 'Medium', color: 'oklch(0.66 0.12 70)' }, // ochre (darker than the amber label)
  high: { label: 'High', color: 'oklch(0.62 0.18 40)' }, // deep orange
  urgent: { label: 'Urgent', color: 'oklch(0.54 0.22 22)' } // deep red
}

export function priorityLabel(p: CardPriority | string | null | undefined): string {
  if (p == null) return 'None'
  const meta = META[p as CardPriority]
  return meta ? meta.label : String(p)
}

export function priorityColor(p: CardPriority): string {
  return META[p].color
}

/** Read-only priority marker shown on the card preview + the card-
 *  detail header. Deliberately NOT a filled pill any more: a solid
 *  flag tinted to the level + the word in the calm muted tone, so it
 *  sits at the same quiet visual weight as the DueBadge instead of
 *  competing with the label chips. The colour still carries the level
 *  at a glance through the flag; the word stays readable in either
 *  theme because it rides the theme-aware muted token, not the accent. */
export function PriorityBadge({ card }: { card: CardView }) {
  if (card.priority == null) return null
  const meta = META[card.priority]
  if (!meta) return null
  return (
    <span
      className="flex w-fit items-center gap-1 text-[11px] font-medium text-muted-foreground"
      title={`Priority: ${meta.label}`}
    >
      <Flag className="size-3" style={{ color: meta.color }} fill={meta.color} />
      {meta.label}
    </span>
  )
}

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

/** Priority editor for the card right-click menu. Each level is a row;
 *  the currently-set one shows a check on the right. Clicking the
 *  active level clears it (a second click on the chosen value = "no
 *  priority"). */
export function PriorityPicker({
  card,
  apply,
  close
}: {
  card: CardView
  apply: Apply
  close: () => void
}) {
  const set = (next: CardPriority | null): void => {
    apply(
      { type: 'card.update', id: card.id, patch: { priority: next } },
      (b) => mapCard(b, card.id, (c) => ({ ...c, priority: next }))
    )
    close()
  }
  return (
    <>
      <MenuLabel>Priority</MenuLabel>
      {PRIORITY_LEVELS.map((p) => {
        const meta = META[p]
        const active = card.priority === p
        return (
          <MenuItem key={p} onClick={() => set(active ? null : p)}>
            <span className="flex w-full items-center justify-between gap-2">
              <span className="inline-flex items-center gap-2">
                <span
                  aria-hidden
                  className="inline-block size-2.5 rounded-full"
                  style={{ backgroundColor: meta.color }}
                />
                {meta.label}
              </span>
              {active && (
                <span className="text-xs text-muted-foreground">Clear</span>
              )}
            </span>
          </MenuItem>
        )
      })}
      {card.priority != null && (
        <MenuItem onClick={() => set(null)}>
          <span className="text-xs text-muted-foreground">No priority</span>
        </MenuItem>
      )}
    </>
  )
}
