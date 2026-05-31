import { arrayMove } from '@dnd-kit/sortable'
import type { BoardSummary } from '@kanbini/shared'

// Pure helpers for the boards-home DnD + keyboard reorder. Same
// rationale as lib/board-dnd.ts: extract the live-cache reorder
// math + the move-step derivation from the closures inside
// `boards-home.tsx` so they're unit-testable without standing up a
// <DndContext>. The closures glue these to `qc.setQueryData` +
// `mutateAndInvalidate`.
//
// Cross-pin-group reordering is rejected up-front - pinning is a
// separate sort layer, not a position. The renderer's UI enforces
// this by disabling DnD when the user isn't on the manual sort, but
// the helpers stay safe to call with mixed input anyway.

/** Reorder the boards array for the live optimistic cache write.
 *  Returns `prev` unchanged when the move would cross pin groups
 *  (rejected) or when either side is missing. */
export function reduceBoardReorder(
  prev: BoardSummary[],
  activeId: string,
  overId: string
): BoardSummary[] {
  if (activeId === overId) return prev
  const activeBoard = prev.find((b) => b.id === activeId)
  const overBoard = prev.find((b) => b.id === overId)
  if (!activeBoard || !overBoard) return prev
  if (activeBoard.pinned !== overBoard.pinned) return prev
  const aIdx = prev.findIndex((b) => b.id === activeId)
  const oIdx = prev.findIndex((b) => b.id === overId)
  if (aIdx === -1 || oIdx === -1) return prev
  return arrayMove(prev, aIdx, oIdx)
}

/** Derive `{beforeId, afterId}` for a board.move mutation from the
 *  post-drag cache. Same-pin-group siblings only - pinned boards
 *  never become neighbours of unpinned ones via this move. Returns
 *  null when the moved board is missing OR when neither neighbour
 *  exists (single-item pin group - no-op). */
export function computeBoardMoveTarget(
  cache: BoardSummary[],
  movedId: string
): { beforeId: string | null; afterId: string | null } | null {
  const moved = cache.find((b) => b.id === movedId)
  if (!moved) return null
  const siblings = cache.filter((b) => b.pinned === moved.pinned)
  const idx = siblings.findIndex((b) => b.id === movedId)
  if (idx === -1) return null
  const beforeId = siblings[idx - 1]?.id ?? null
  const afterId = siblings[idx + 1]?.id ?? null
  if (beforeId === null && afterId === null) return null
  return { beforeId, afterId }
}

/** Compute the (beforeId, afterId) for a "Move up" / "Move down"
 *  keyboard step on the same-pin-group siblings of `id`. Returns
 *  null at the ends (top of group + up, bottom of group + down) or
 *  when the id can't be located. Caller (boards-home.tsx) wraps
 *  this in a board.move mutation. */
export function computeBoardMoveStep(
  visible: BoardSummary[],
  id: string,
  direction: 'up' | 'down'
): { beforeId: string | null; afterId: string | null } | null {
  const board = visible.find((b) => b.id === id)
  if (!board) return null
  const siblings = visible.filter((b) => b.pinned === board.pinned)
  const idx = siblings.findIndex((b) => b.id === id)
  if (idx === -1) return null
  if (direction === 'up' && idx === 0) return null
  if (direction === 'down' && idx === siblings.length - 1) return null
  const beforeId =
    direction === 'up'
      ? (siblings[idx - 2]?.id ?? null)
      : siblings[idx + 1]!.id
  const afterId =
    direction === 'up'
      ? siblings[idx - 1]!.id
      : (siblings[idx + 2]?.id ?? null)
  return { beforeId, afterId }
}
