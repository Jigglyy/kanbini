import { useQuery } from '@tanstack/react-query'
import { ipc } from '../lib/ipc'

// Single-board query, scoped by id (M4-G). The change-event bus
// invalidates the `['board']` prefix, so AI/other-window edits stream
// in regardless of which board the user has open (ADR-0013).
//
// `boardKey(id)` is the specific cache slot - used by useBoard and the
// optimistic-update path. `boardsRootKey` is the prefix every consumer
// invalidates against (TanStack Query treats it as a partial match,
// so it sweeps every per-id entry too).
export const boardsRootKey = ['board'] as const
export const boardKey = (id: string | undefined) =>
  ['board', id ?? ''] as const

export function useBoard(boardId: string | undefined) {
  return useQuery({
    queryKey: boardKey(boardId),
    queryFn: () => ipc.getBoardView(boardId),
    enabled: boardId != null
  })
}
