// Per-board "last opened at" timestamps, persisted to localStorage.
// Powers the boards-home "Recently opened" sort mode. Renderer-only
// (UI affordance - domain data stays in SQLite); a simple object map
// is enough because the home picker reads the whole thing once on
// mount and Kanbini is single-window today.

const KEY = 'kanbini.lastOpenedAt'

/** Read the full map. Returns an empty object on any storage issue -
 *  this is a UI nicety, not load-bearing data. Rejects arrays as
 *  well as primitives + null; `typeof [] === 'object'` is true so a
 *  bare `Array.isArray` guard is what filters them out. */
export function loadOpenedMap(): Record<string, number> {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return {}
    if (Array.isArray(parsed)) return {}
    return parsed as Record<string, number>
  } catch {
    return {}
  }
}

/** Stamp `boardId` with the current time. Called from the App route
 *  when the user opens a board (or the auto-jump fires on launch). */
export function recordOpened(boardId: string): void {
  const map = loadOpenedMap()
  map[boardId] = Date.now()
  try {
    localStorage.setItem(KEY, JSON.stringify(map))
  } catch {
    /* full disk / private mode - sort just stays where it was */
  }
}
