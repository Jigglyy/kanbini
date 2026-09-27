import type { BoardSummary } from '@kanbini/shared'
import type { StartMode } from './settings'

// Which board (if any) the app opens on launch - Settings, Startup.
// Pure so the rules are unit-testable; App.tsx calls it once, on the
// first successful boards load.

export function startupBoardId(
  mode: StartMode,
  opts: {
    /** Settings.startBoardId: the board picked for `board` mode. */
    startBoardId: string | null
    /** localStorage kanbini.lastBoardId: the last board opened. */
    lastBoardId: string | null
    boards: readonly Pick<BoardSummary, 'id' | 'archived'>[]
  }
): string | null {
  const find = (id: string | null) =>
    id ? opts.boards.find((b) => b.id === id) : undefined
  if (mode === 'lastBoard') return find(opts.lastBoardId)?.id ?? null
  if (mode === 'board') {
    // A deleted or archived pick falls back to the boards list rather
    // than opening something the user put away.
    const b = find(opts.startBoardId)
    return b && !b.archived ? b.id : null
  }
  return null
}
