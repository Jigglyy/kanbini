import type { BoardView } from '@kanbini/shared'

// Header label-filter helpers (M1). Pulled out of App.tsx so they're
// unit-testable without standing up the whole app, and so the
// stale-filter pruning lives next to the filter it guards.

/** Project a board down to cards carrying at least one of the active
 *  label ids (OR semantics). An empty set means "no filter" and the
 *  whole board passes through unchanged (same reference). */
export function filterByLabels(
  b: BoardView,
  active: ReadonlySet<string>
): BoardView {
  if (active.size === 0) return b
  return {
    ...b,
    lists: b.lists.map((l) => ({
      ...l,
      cards: l.cards.filter((c) => c.labelIds.some((id) => active.has(id)))
    }))
  }
}

/** Drop active-filter ids that no longer exist on the board. Without
 *  this, deleting the label you're currently filtering by (from the
 *  filter bar's right-click editor, or an AI / other-window edit)
 *  leaves a stale id that matches no card - so `filterByLabels` hides
 *  EVERY card and there's no chip left to un-toggle, stranding the user
 *  on an empty board. Returns the SAME set when nothing was pruned so
 *  the caller can skip a state update / re-render. */
export function pruneLabelFilter(
  active: ReadonlySet<string>,
  existingLabelIds: Iterable<string>
): ReadonlySet<string> {
  if (active.size === 0) return active
  const exist =
    existingLabelIds instanceof Set
      ? existingLabelIds
      : new Set(existingLabelIds)
  let changed = false
  const next = new Set<string>()
  for (const id of active) {
    if (exist.has(id)) next.add(id)
    else changed = true
  }
  return changed ? next : active
}
