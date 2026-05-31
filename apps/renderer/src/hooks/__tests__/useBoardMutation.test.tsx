import { act, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { BoardView, Mutation, MutationResult } from '@kanbini/shared'
import { useBoardMutation } from '../useBoardMutation'
import { boardKey, boardsRootKey } from '../useBoard'
import { renderHookWithQuery } from '../../__tests__/_render'
import { kanbiniMock } from '../../__tests__/_kanbini-mock'

// Tests for the central optimistic-write helper that every renderer
// CRUD call funnels through (ADR-0013). The contract:
//   - Pre-seed: snapshot the current cache slot
//   - On mutate: write the optimistic projection to the cache
//   - On settle: invalidate the boards root prefix
//   - On error: roll back to the snapshot
// Each test seeds a starting BoardView into the cache, fires a real
// mutate call (against the window.kanbini mock), and asserts the
// cache + the ipc invocations.

function makeBoard(id: string, listName = 'Todo'): BoardView {
  return {
    project: { id: 'p1', name: 'P' },
    board: {
      id,
      name: 'Test board',
      color: null,
      background: null,
      swimlaneMode: null
    },
    labels: [],
    lists: [
      {
        id: 'list-1',
        name: listName,
        color: null,
        closed: false,
        position: 'a0',
        wipLimit: null,
        sortMode: null,
        onEnter: null,
        cards: []
      }
    ]
  }
}

describe('useBoardMutation', () => {
  it('writes the optimistic projection to the per-board cache slot', async () => {
    const boardId = 'b1'
    const { result, client } = renderHookWithQuery(() =>
      useBoardMutation(boardId)
    )
    client.setQueryData<BoardView>(boardKey(boardId), makeBoard(boardId))

    const mutation: Mutation = {
      type: 'list.update',
      id: 'list-1',
      patch: { name: 'Doing' }
    }
    act(() => {
      result.current(mutation, (b) => ({
        ...b,
        lists: b.lists.map((l) =>
          l.id === 'list-1' ? { ...l, name: 'Doing' } : l
        )
      }))
    })

    // onMutate is async (awaits qc.cancelQueries first) - the cache
    // update lands one microtask after mutate() returns. Wait for it.
    await waitFor(() => {
      const optimistic = client.getQueryData<BoardView>(boardKey(boardId))
      expect(optimistic?.lists[0]?.name).toBe('Doing')
    })

    // ipc.mutate was invoked with the same mutation object the caller
    // passed in (the wrapper unwraps `{m, optimistic}` and forwards
    // only `m`).
    expect(kanbiniMock().mutate).toHaveBeenCalledTimes(1)
    expect(kanbiniMock().mutate).toHaveBeenCalledWith(mutation)
  })

  it('rolls back the cache when the IPC call rejects', async () => {
    const boardId = 'b2'
    kanbiniMock().mutate.mockRejectedValueOnce(new Error('boom'))

    const { result, client } = renderHookWithQuery(() =>
      useBoardMutation(boardId)
    )
    const before = makeBoard(boardId)
    client.setQueryData<BoardView>(boardKey(boardId), before)

    act(() => {
      result.current(
        { type: 'list.update', id: 'list-1', patch: { name: 'Never' } },
        (b) => ({
          ...b,
          lists: b.lists.map((l) =>
            l.id === 'list-1' ? { ...l, name: 'Never' } : l
          )
        })
      )
    })

    // Wait for the mutation to fail + onError to restore the snapshot.
    await waitFor(() => {
      const after = client.getQueryData<BoardView>(boardKey(boardId))
      expect(after?.lists[0]?.name).toBe('Todo')
    })
  })

  it('invalidates the `["board"]` prefix on settle (covers cross-board AI edits)', async () => {
    const boardId = 'b3'
    const otherBoardId = 'b3-other'
    const { result, client } = renderHookWithQuery(() =>
      useBoardMutation(boardId)
    )
    client.setQueryData<BoardView>(boardKey(boardId), makeBoard(boardId))
    client.setQueryData<BoardView>(
      boardKey(otherBoardId),
      makeBoard(otherBoardId, 'Other')
    )
    expect(
      client.getQueryState(boardKey(otherBoardId))?.isInvalidated
    ).toBe(false)

    const mockResult: MutationResult = { id: 'list-1', boardId }
    kanbiniMock().mutate.mockResolvedValueOnce(mockResult)

    act(() => {
      result.current(
        { type: 'list.update', id: 'list-1', patch: { name: 'Doing' } },
        (b) => b
      )
    })

    // After settle, both per-id slots (and the root prefix itself)
    // are marked invalidated - TanStack Query treats the
    // `['board']` prefix as a partial match.
    await waitFor(() => {
      expect(
        client.getQueryState(boardKey(boardId))?.isInvalidated
      ).toBe(true)
      expect(
        client.getQueryState(boardKey(otherBoardId))?.isInvalidated
      ).toBe(true)
    })
    // Sanity-check: the root key is the prefix every per-board query
    // matches under.
    expect(boardsRootKey).toEqual(['board'])
  })

  it('survives an empty cache (no snapshot to optimistic-project against)', async () => {
    // First-time mutation on a board the user just opened - the
    // query is in flight, the cache is empty, the optimistic projection
    // should be skipped rather than crash on `optimistic(undefined)`.
    const boardId = 'b4'
    const { result, client } = renderHookWithQuery(() =>
      useBoardMutation(boardId)
    )
    expect(client.getQueryData(boardKey(boardId))).toBeUndefined()
    let optimisticCalled = false
    act(() => {
      result.current(
        { type: 'list.update', id: 'list-1', patch: { name: 'x' } },
        (b) => {
          optimisticCalled = true
          return b
        }
      )
    })
    // ipc.mutate fires after onMutate's microtask completes.
    await waitFor(() => {
      expect(kanbiniMock().mutate).toHaveBeenCalledTimes(1)
    })
    // Optimistic projection skipped because prev was undefined.
    expect(optimisticCalled).toBe(false)
  })

  it('returns a referentially stable apply across re-renders', () => {
    // `apply` is threaded into every React.memo'd SortableCard /
    // ListColumn. The memoisation (which keeps a drag reorder from
    // re-rendering the whole board - the "choppy reorder" fix) only
    // holds if `apply` keeps the same identity across renders. A fresh
    // closure here would bust every card's memo on every parent render.
    const { result, rerender } = renderHookWithQuery(() =>
      useBoardMutation('b-stable')
    )
    const first = result.current
    expect(typeof first).toBe('function')
    rerender()
    rerender()
    expect(result.current).toBe(first)
  })
})
