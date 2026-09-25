import type { BoardView, CardDensity, CardView } from '@kanbini/shared'

// Card density: pure helpers behind collapsible cards and a list's
// compact mode. Kept out of the components so the resolution rule and
// the toggle maths are unit-testable (board.tsx has no render harness).
//
// The stored model is three-state on the card and a default on the list:
//   card.collapsed      null = follow the list, true = compact, false = full
//   list.cardDensity    null = full cards, 'compact' = compact cards

/** Does this card render compact? The card's own choice wins; null
 *  falls back to the list's density. */
export function isCardCompact(
  collapsed: boolean | null,
  density: CardDensity | null
): boolean {
  return collapsed ?? density === 'compact'
}

/** The `collapsed` value that makes a card render as `compact` in a list
 *  of the given density, storing an override only when the card has to
 *  DIFFER from its list. Keeps the data minimal: a card toggled back to
 *  match its list returns to null, so a later change of list density
 *  carries it along instead of leaving a stale override behind. */
export function collapsedFor(
  compact: boolean,
  density: CardDensity | null
): boolean | null {
  const listCompact = density === 'compact'
  if (compact === listCompact) return null
  return compact
}

/** Next `collapsed` value when the user toggles a card's collapse. */
export function toggledCollapsed(
  collapsed: boolean | null,
  density: CardDensity | null
): boolean | null {
  return collapsedFor(!isCardCompact(collapsed, density), density)
}

/** Optimistic projection: one card's `collapsed` changes. */
export function withCardCollapsed(
  b: BoardView,
  cardId: string,
  collapsed: boolean | null
): BoardView {
  return {
    ...b,
    lists: b.lists.map((l) =>
      l.cards.some((c) => c.id === cardId)
        ? {
            ...l,
            cards: l.cards.map((c) => (c.id === cardId ? { ...c, collapsed } : c))
          }
        : l
    )
  }
}

/** Checklist progress across every checklist on the card, or null when
 *  it has no items at all (a compact card then shows no checklist badge). */
export function checklistProgress(
  card: Pick<CardView, 'checklists'>
): { done: number; total: number } | null {
  let done = 0
  let total = 0
  for (const cl of card.checklists) {
    for (const it of cl.items) {
      total += 1
      if (it.completed) done += 1
    }
  }
  return total === 0 ? null : { done, total }
}
