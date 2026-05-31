import { useQuery } from '@tanstack/react-query'
import { ipc } from '../lib/ipc'

// Home-picker query (M4-G). The change-event listener in App.tsx
// invalidates `boardsListKey` after every mutation so counts stay
// fresh (cards added/removed bump cardCount; board.update bumps
// updatedAt) - same live-reconciliation contract as the board view.
export const boardsListKey = ['boardsList'] as const

export function useBoardsList() {
  return useQuery({
    queryKey: boardsListKey,
    queryFn: () => ipc.listBoards()
  })
}
