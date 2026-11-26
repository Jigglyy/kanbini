import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  isBoardReadOnly,
  lockedScopeId,
  notifyWriteBlocked,
  onWriteBlocked,
  pruneReadOnlyBoards,
  setBoardReadOnly,
  useBoardReadOnly,
  useReadOnlyScope
} from '../read-only'

describe('read-only boards', () => {
  it('persists the locked ids under kanbini.readOnlyBoards', () => {
    expect(isBoardReadOnly('b1')).toBe(false)
    setBoardReadOnly('b1', true)
    expect(isBoardReadOnly('b1')).toBe(true)
    expect(JSON.parse(localStorage.getItem('kanbini.readOnlyBoards')!)).toEqual(['b1'])
    setBoardReadOnly('b1', false)
    expect(isBoardReadOnly('b1')).toBe(false)
    expect(JSON.parse(localStorage.getItem('kanbini.readOnlyBoards')!)).toEqual([])
  })

  it('reads a junk value as nothing locked', () => {
    localStorage.setItem('kanbini.readOnlyBoards', '"b1"')
    expect(isBoardReadOnly('b1')).toBe(false)
  })

  it('the hook re-renders when the lock flips', () => {
    const { result } = renderHook(() => useBoardReadOnly('b1'))
    expect(result.current[0]).toBe(false)
    act(() => result.current[1](true))
    expect(result.current[0]).toBe(true)
    expect(isBoardReadOnly('b1')).toBe(true)
  })

  it('a mounted scope reports its board only while it is locked and mounted', () => {
    const scope = renderHook(() => useReadOnlyScope('b1'))
    expect(lockedScopeId()).toBeNull()
    setBoardReadOnly('b1', true)
    expect(lockedScopeId()).toBe('b1')
    scope.unmount()
    expect(lockedScopeId()).toBeNull()
  })

  it('two scopes on one board: the board stays on screen until both unmount', () => {
    setBoardReadOnly('b1', true)
    const a = renderHook(() => useReadOnlyScope('b1'))
    const b = renderHook(() => useReadOnlyScope('b1'))
    a.unmount()
    expect(lockedScopeId()).toBe('b1')
    b.unmount()
    expect(lockedScopeId()).toBeNull()
  })

  it('onWriteBlocked subscribers hear the board id until they unsubscribe', () => {
    const cb = vi.fn()
    const off = onWriteBlocked(cb)
    notifyWriteBlocked('b1')
    expect(cb).toHaveBeenCalledWith('b1')
    off()
    notifyWriteBlocked('b1')
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('forgets locks on boards that no longer exist', () => {
    setBoardReadOnly('b1', true)
    setBoardReadOnly('gone', true)
    const { result } = renderHook(() => useBoardReadOnly('gone'))
    expect(result.current[0]).toBe(true)
    let removed = false
    act(() => {
      removed = pruneReadOnlyBoards(['b1', 'b2'])
    })
    expect(removed).toBe(true)
    expect(isBoardReadOnly('b1')).toBe(true)
    expect(isBoardReadOnly('gone')).toBe(false)
    expect(result.current[0]).toBe(false)
    // Nothing stale: nothing written.
    expect(pruneReadOnlyBoards(['b1'])).toBe(false)
  })
})
