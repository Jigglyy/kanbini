import type { BoardView } from '@kanbini/shared'

// Per-board "Hide completed" (a view preference, like the label order:
// renderer-only, localStorage, never a DB column). App layers it on top
// of the label filter; the header toggle flips it and shows how many
// completed cards there are.

const STORAGE_KEY = 'kanbini.hideCompleted'

function readMap(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, boolean>)
      : {}
  } catch {
    return {}
  }
}

export function loadHideCompleted(boardId: string): boolean {
  return readMap()[boardId] === true
}

export function saveHideCompleted(boardId: string, hide: boolean): void {
  try {
    const map = readMap()
    if (hide) map[boardId] = true
    else delete map[boardId]
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    /* private mode - the toggle still works for this session */
  }
}

/** Drop completed cards when `hide` is on. Off returns the same board
 *  object, so memoised consumers don't re-render. */
export function filterCompleted(b: BoardView, hide: boolean): BoardView {
  if (!hide) return b
  return {
    ...b,
    lists: b.lists.map((l) => ({
      ...l,
      cards: l.cards.filter((c) => !c.completed)
    }))
  }
}

/** Completed cards the user could see (open lists only). */
export function countCompleted(b: BoardView): number {
  let n = 0
  for (const l of b.lists) {
    if (l.closed) continue
    for (const c of l.cards) if (c.completed) n++
  }
  return n
}
