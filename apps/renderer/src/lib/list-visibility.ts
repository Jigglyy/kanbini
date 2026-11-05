// "Show first N" for long lists (list.visibleCardLimit). Pure helpers so
// the rules that keep a hidden card reachable are unit-testable; Board
// and ListColumn only wire them to state.
//
// The limit is PRESENTATIONAL: list.cards always holds every card, the
// header count and WIP limit count all of them, and the MCP server reads
// all of them. What changes is which cards are mounted:
//
//   - `revealed` (per session, never saved): "Show N more" was clicked,
//     or something revealed the list for you (keyboard focus moved to a
//     hidden card, search opened one, you added a card at the bottom).
//   - `pinned`: cards moved INTO this list this session. A card you just
//     dropped always shows, even past the limit, and pinned cards don't
//     use up one of the N slots, so a drop never makes some other card
//     vanish from view.
//   - `activeId`: a card being dragged INTO this list from another one
//     counts as pinned for the same reason while it's in the air. A card
//     dragged within its own list is NOT passed here - it keeps its
//     normal slot, so picking it up doesn't pull a hidden card into view.
//
// The limit itself comes from `effectiveCardLimit`: the list's own choice
// (list.visibleCardLimit), or, when it has none, the automatic one
// (settings.shortenLongLists): a list of more than AUTO_CARD_LIMIT_ABOVE
// cards shows its first AUTO_CARD_LIMIT. SHOW_ALL_CARDS (0) opts a list
// out of that.

import {
  AUTO_CARD_LIMIT,
  AUTO_CARD_LIMIT_ABOVE,
  SHOW_ALL_CARDS
} from '@kanbini/shared'

/** The limit a list is drawn with: its own choice, else the automatic
 *  one for a long list (when that setting is on), else none. */
export function effectiveCardLimit(
  stored: number | null,
  cardCount: number,
  auto: boolean
): number | null {
  if (stored === SHOW_ALL_CARDS) return null
  if (stored != null) return stored
  return auto && cardCount > AUTO_CARD_LIMIT_ABOVE ? AUTO_CARD_LIMIT : null
}

/** How many cards the automatic limit judges a list by. While a card is
 *  dragged to another list it already sits in the destination's cards
 *  (the live reorder) and no longer in the source's, so count every list
 *  as it was at pickup: a list mustn't fold or unfold under the pointer
 *  because a card crossed the threshold mid-drag. */
export function limitCardCount(
  cards: readonly { id: string }[],
  listId: string,
  activeId: string | null,
  sourceListId: string | null
): number {
  if (activeId == null) return cards.length
  const holdsActive = cards.some((c) => c.id === activeId)
  return cards.length - (holdsActive ? 1 : 0) + (listId === sourceListId ? 1 : 0)
}

export interface ListVisibility<T> {
  shown: T[]
  hiddenCount: number
}

export function visibleCards<T extends { id: string }>(
  cards: readonly T[],
  limit: number | null,
  revealed: boolean,
  pinned: ReadonlySet<string>,
  activeId: string | null = null
): ListVisibility<T> {
  if (limit == null || revealed || cards.length <= limit) {
    return { shown: cards as T[], hiddenCount: 0 }
  }
  const shown: T[] = []
  let slots = 0
  let hidden = 0
  for (const c of cards) {
    if (c.id === activeId || pinned.has(c.id)) {
      shown.push(c)
    } else if (slots < limit) {
      shown.push(c)
      slots += 1
    } else {
      hidden += 1
    }
  }
  return { shown, hiddenCount: hidden }
}

/** Is this card currently hidden by its list's limit? */
export function isCardHidden<T extends { id: string }>(
  cards: readonly T[],
  cardId: string,
  limit: number | null,
  revealed: boolean,
  pinned: ReadonlySet<string>
): boolean {
  if (!cards.some((c) => c.id === cardId)) return false
  return !visibleCards(cards, limit, revealed, pinned).shown.some(
    (c) => c.id === cardId
  )
}

/** A drop resolved against the list droppable itself (`list:<id>` - the
 *  "Show N more" footer, or the empty space below the last visible card)
 *  would normally append at the TRUE end of the list, behind every hidden
 *  card, where you can't see it land. When the list is truncated, aim it
 *  just after the last card on screen instead. Anything else passes
 *  through unchanged. `shownIds` is the visible order for that list, or
 *  null when the list isn't truncated. */
export function resolveTruncatedDrop(
  overId: string,
  position: 'before' | 'after',
  activeId: string,
  shownIdsOf: (listId: string) => readonly string[] | null
): { overId: string; position: 'before' | 'after' } {
  if (!overId.startsWith('list:')) return { overId, position }
  const shown = shownIdsOf(overId.slice('list:'.length))
  if (!shown) return { overId, position }
  const last = [...shown].reverse().find((id) => id !== activeId)
  return last ? { overId: last, position: 'after' } : { overId, position }
}

/** What the list's footer should offer: "Show N more" when cards are
 *  hidden, "Show fewer" only when folding back would actually hide
 *  something (pinned cards never fold away, so a revealed list whose
 *  extra cards are all pinned has nothing to fold), else nothing. Shared
 *  by the real column and the list-drag preview so the two can't drift. */
export function listFooterState<T extends { id: string }>(
  cards: readonly T[],
  limit: number | null,
  revealed: boolean,
  pinned: ReadonlySet<string>,
  activeId: string | null = null
): { kind: 'more'; count: number } | { kind: 'fewer' } | null {
  const now = visibleCards(cards, limit, revealed, pinned, activeId)
  if (now.hiddenCount > 0) return { kind: 'more', count: now.hiddenCount }
  if (revealed && visibleCards(cards, limit, false, pinned, activeId).hiddenCount > 0) {
    return { kind: 'fewer' }
  }
  return null
}

/** The limits the list menu offers: null = automatic, 0 = every card. */
export const VISIBLE_LIMIT_OPTIONS: ReadonlyArray<number | null> = [
  null,
  10,
  20,
  50,
  SHOW_ALL_CARDS
]
