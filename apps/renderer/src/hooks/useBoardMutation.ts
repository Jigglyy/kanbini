import { useCallback } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { BoardView, Mutation } from '@kanbini/shared'
import { boardKey, boardsRootKey } from './useBoard'
import { ipc } from '../lib/ipc'

// One optimistic mutation runner shared by the board + label UIs:
// cancel in-flight → snapshot → optimistic cache write → rollback on
// error → invalidate on settle (the `changed` event also invalidates,
// so AI/other-window edits reconcile too). ADR-0013.
//
// M4-G: takes the current boardId so the optimistic cache writes hit
// the right `['board', id]` slot. Invalidation still uses the prefix
// so any board's edit (e.g. AI editing the *other* open window) is
// also picked up.

export type Optimistic = (b: BoardView) => BoardView

export function useBoardMutation(
  boardId: string | undefined
): (m: Mutation, o: Optimistic) => void {
  const qc = useQueryClient()
  const key = boardKey(boardId)
  const mutation = useMutation({
    mutationFn: (v: { m: Mutation; optimistic: Optimistic }) => ipc.mutate(v.m),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<BoardView | null>(key)
      if (prev) qc.setQueryData<BoardView | null>(key, v.optimistic(prev))
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx) qc.setQueryData(key, ctx.prev)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: boardsRootKey })
  })
  // Stable identity across renders so consumers can be `React.memo`'d -
  // a fresh closure here would defeat the card/list memoisation that
  // keeps drag reorders from re-rendering the whole board. `mutate` is
  // itself stable (react-query), so this never actually changes.
  const { mutate } = mutation
  return useCallback(
    (m: Mutation, optimistic: Optimistic) => mutate({ m, optimistic }),
    [mutate]
  )
}
