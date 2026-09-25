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
//   - `activeId`: the card being dragged counts as pinned for the same
//     reason while it's in the air.

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

/** The limits the list menu offers; null = show all. */
export const VISIBLE_LIMIT_OPTIONS: ReadonlyArray<number | null> = [10, 20, 50, null]
