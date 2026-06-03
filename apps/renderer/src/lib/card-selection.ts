// Pure helpers for multi-card selection + bulk actions on the board.
// Kept DOM-free so the selection-set maths and the "what does a bulk
// toggle resolve to" decisions are unit-testable without a board render.
//
// Interaction model (board.tsx): a plain click opens a card; Ctrl/Cmd +
// click toggles it in the selection; Shift + click range-selects within a
// list. When 1+ cards are selected a floating action bar + a bulk
// right-click menu operate on the whole selection.

export type ClickIntent = 'open' | 'toggle' | 'range'

/** Map a click's modifier keys to the card-click intent. Ctrl or Cmd =
 *  toggle this card in the selection; Shift = range-select; otherwise
 *  open the card. */
export function clickIntent(e: {
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}): ClickIntent {
  if (e.ctrlKey || e.metaKey) return 'toggle'
  if (e.shiftKey) return 'range'
  return 'open'
}

/** Toggle `id` in `set`, returning a NEW set (selection is treated as
 *  immutable so the React state update is a clean replace). */
export function toggleSelection(
  set: ReadonlySet<string>,
  id: string
): Set<string> {
  const next = new Set(set)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

/** Ids from `anchorId` to `targetId` inclusive within one list's ordered
 *  `cardIds` (either direction). Empty when either id is not in the list,
 *  so a cross-list Shift+click falls back to a plain toggle. */
export function rangeWithinList(
  cardIds: string[],
  anchorId: string,
  targetId: string
): string[] {
  const a = cardIds.indexOf(anchorId)
  const b = cardIds.indexOf(targetId)
  if (a < 0 || b < 0) return []
  const [lo, hi] = a <= b ? [a, b] : [b, a]
  return cardIds.slice(lo, hi + 1)
}

/** Resolve a bulk complete toggle: if EVERY selected card is already
 *  complete, the action un-completes them all; otherwise it completes
 *  them all. Empty selection -> complete (true), never hit in practice. */
export function bulkCompleteTarget(cards: { completed: boolean }[]): boolean {
  return !(cards.length > 0 && cards.every((c) => c.completed))
}

/** Plan where a multi-card drag re-clusters the selection. After the
 *  dragged "lead" card has been placed (by the live onDragOver reorder)
 *  inside `cards` - its destination list - the whole selection should sit
 *  together at that spot. Returns the nearest NON-selected neighbours that
 *  bound the block (so other selected cards still scattered in the list
 *  are skipped) plus the block ids in their original order. The caller
 *  fires one card.move per id, chaining `beforeId` through the block, so
 *  they land contiguous + ordered between `beforeId` and `afterId`.
 *  Null when the lead isn't in `cards` (caller falls back to single). */
export function planMultiCardMove(
  cards: { id: string }[],
  leadId: string,
  selected: ReadonlySet<string>,
  block: string[]
): { beforeId: string | null; afterId: string | null; orderedIds: string[] } | null {
  const leadIdx = cards.findIndex((c) => c.id === leadId)
  if (leadIdx < 0) return null
  let beforeId: string | null = null
  for (let i = leadIdx - 1; i >= 0; i--) {
    if (!selected.has(cards[i]!.id)) {
      beforeId = cards[i]!.id
      break
    }
  }
  let afterId: string | null = null
  for (let i = leadIdx + 1; i < cards.length; i++) {
    if (!selected.has(cards[i]!.id)) {
      afterId = cards[i]!.id
      break
    }
  }
  return { beforeId, afterId, orderedIds: block }
}

/** Resolve a bulk label toggle: if EVERY selected card already carries
 *  `labelId`, remove it from all; otherwise add it to the ones missing
 *  it. `targets` is the minimal set of card ids that actually change, so
 *  the caller fires no redundant mutations. */
export function bulkLabelAction(
  cards: { id: string; labelIds: string[] }[],
  labelId: string
): { add: boolean; targets: string[] } {
  const all =
    cards.length > 0 && cards.every((c) => c.labelIds.includes(labelId))
  const add = !all
  const targets = cards
    .filter((c) =>
      add ? !c.labelIds.includes(labelId) : c.labelIds.includes(labelId)
    )
    .map((c) => c.id)
  return { add, targets }
}
