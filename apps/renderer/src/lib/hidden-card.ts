import type { BoardView } from '@kanbini/shared'
import { filterCompleted } from './hide-completed'
import { filterByLabels } from './label-filter'

// "Show on board" can target a card the board view filters out (the
// header's label filter, or "Hide completed"). Rather than quietly
// changing the user's filters, App says which one hides the card and
// offers to clear it; this works out which.

export interface HiddenCardReason {
  title: string
  byLabels: boolean
  byCompleted: boolean
}

const onScreen = (b: BoardView, cardId: string): boolean =>
  b.lists.some((l) => !l.closed && l.cards.some((c) => c.id === cardId))

/** Why card `cardId` isn't on screen, or null when no filter hides it
 *  (it's on screen, in a closed list, or not on this board at all).
 *  `data` is the unfiltered board view. */
export function hiddenCardReason(
  data: BoardView,
  cardId: string,
  activeLabels: ReadonlySet<string>,
  hideCompleted: boolean
): HiddenCardReason | null {
  if (!onScreen(data, cardId)) return null
  const card = data.lists.flatMap((l) => l.cards).find((c) => c.id === cardId)!
  const byLabels = !onScreen(filterByLabels(data, activeLabels), cardId)
  const byCompleted = !onScreen(filterCompleted(data, hideCompleted), cardId)
  if (!byLabels && !byCompleted) return null
  return { title: card.title, byLabels, byCompleted }
}
