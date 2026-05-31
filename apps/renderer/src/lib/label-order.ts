// Per-board manual order for the header label filter bar. The DB
// returns labels in creation order (UUIDv7 id, see getBoardView); this
// layers an optional user-chosen order on top, persisted per board in
// localStorage. Label order is a display preference (which order the
// filter chips sit in), not board data - same class as the sort-mode /
// expanded-state prefs - so it lives renderer-side, not in the DB.

const KEY = (boardId: string): string => `kanbini.labelOrder.${boardId}`

/** The saved id order for a board, or [] when the user hasn't reordered
 *  (default = creation order from the DB). */
export function loadLabelOrder(boardId: string): string[] {
  try {
    const raw = localStorage.getItem(KEY(boardId))
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string')
      : []
  } catch {
    return []
  }
}

function saveLabelOrder(boardId: string, ids: string[]): void {
  try {
    localStorage.setItem(KEY(boardId), JSON.stringify(ids))
  } catch {
    /* full disk / private mode - order just won't persist */
  }
}

/** Reorder `labels` by the board's saved manual order. Labels not named
 *  in the saved order keep their incoming (creation) order and sit
 *  after the ordered ones; saved ids that no longer exist are ignored.
 *  Returns the input unchanged when there's no saved order, so the
 *  default is exactly the DB's creation order. */
export function applyLabelOrder<T extends { id: string }>(
  labels: T[],
  boardId: string
): T[] {
  const order = loadLabelOrder(boardId)
  if (order.length === 0) return labels
  const rank = new Map(order.map((id, i) => [id, i]))
  // Array.sort is stable, so unranked (new) labels keep their relative
  // creation order behind the explicitly-ordered ones.
  return [...labels].sort(
    (a, b) =>
      (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity)
  )
}

/** Move `labelId` one slot (`dir` = -1 left / +1 right) within the
 *  current displayed order and persist the result. No-op at the edges.
 *  Returns the new order (or the input when nothing moved). The
 *  keyboard / no-pointer fallback for the drag reorder below. */
export function moveLabelInOrder(
  boardId: string,
  orderedIds: string[],
  labelId: string,
  dir: -1 | 1
): string[] {
  const i = orderedIds.indexOf(labelId)
  const j = i + dir
  if (i < 0 || j < 0 || j >= orderedIds.length) return orderedIds
  const next = [...orderedIds]
  ;[next[i], next[j]] = [next[j]!, next[i]!]
  saveLabelOrder(boardId, next)
  return next
}

/** Pure projection for a drag reorder: a new id array with `activeId`
 *  moved to the slot currently held by `overId` (dnd-kit arrayMove
 *  semantics for a horizontal SortableContext). Returns the SAME array
 *  reference when nothing changes (ids equal, either id missing, or no
 *  net movement) so the caller can skip the persist + re-render. */
export function projectReorder(
  orderedIds: string[],
  activeId: string,
  overId: string
): string[] {
  if (activeId === overId) return orderedIds
  const from = orderedIds.indexOf(activeId)
  const to = orderedIds.indexOf(overId)
  if (from < 0 || to < 0 || from === to) return orderedIds
  const next = [...orderedIds]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved!)
  return next
}

/** Apply a drag reorder (drop `activeId` onto `overId`'s slot), persist
 *  it, and return the new order. No-op (returns the input ref, writes
 *  nothing) when the projection doesn't change anything. */
export function reorderLabels(
  boardId: string,
  orderedIds: string[],
  activeId: string,
  overId: string
): string[] {
  const next = projectReorder(orderedIds, activeId, overId)
  if (next === orderedIds) return orderedIds
  saveLabelOrder(boardId, next)
  return next
}
