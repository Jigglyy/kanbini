import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useJustCompleted } from '../animations'

// Hook test for the celebrate-on-complete trigger. The contract is
// subtle:
//   - Fires only on the incomplete → complete edge (not the reverse)
//   - Stays silent on first mount when the card is already complete
//     (so a refetch doesn't pop every done card on the board)
//   - Returns 'a' / 'b' alternating per fire (CSS-animation restart
//     trick - same class name wouldn't re-trigger keyframes)
//   - Returns null after `durationMs`

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useJustCompleted', () => {
  it('returns null on first mount when the card is incomplete', () => {
    const { result } = renderHook(({ done }) => useJustCompleted(done), {
      initialProps: { done: false }
    })
    expect(result.current).toBeNull()
  })

  it('stays silent on first mount when the card is already complete', () => {
    // A board refetch re-mounts cards. Pre-completed cards must not
    // trigger the celebrate - that'd pop every Done card every time.
    const { result } = renderHook(({ done }) => useJustCompleted(done), {
      initialProps: { done: true }
    })
    expect(result.current).toBeNull()
  })

  it('fires on the incomplete → complete edge + returns a non-null phase', () => {
    const { result, rerender } = renderHook(
      ({ done }) => useJustCompleted(done),
      { initialProps: { done: false } }
    )
    expect(result.current).toBeNull()
    rerender({ done: true })
    expect(result.current === 'a' || result.current === 'b').toBe(true)
  })

  it('alternates a / b across rapid re-fires (CSS restart trick)', () => {
    const { result, rerender } = renderHook(
      ({ done }) => useJustCompleted(done),
      { initialProps: { done: false } }
    )
    // First edge.
    rerender({ done: true })
    const first = result.current
    expect(first === 'a' || first === 'b').toBe(true)
    // Toggle off + on again (skip the duration timer so we see a
    // back-to-back fire, exactly the scenario the alternation is
    // there to handle).
    rerender({ done: false })
    rerender({ done: true })
    const second = result.current
    expect(second === 'a' || second === 'b').toBe(true)
    expect(second).not.toBe(first)
  })

  it('returns null after the duration elapses', () => {
    const { result, rerender } = renderHook(
      ({ done }) => useJustCompleted(done, 100),
      { initialProps: { done: false } }
    )
    rerender({ done: true })
    expect(result.current).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(101)
    })
    expect(result.current).toBeNull()
  })

  it('does NOT fire on the complete → incomplete edge', () => {
    const { result, rerender } = renderHook(
      ({ done }) => useJustCompleted(done),
      { initialProps: { done: false } }
    )
    // First fire to know what `tick` would have been:
    rerender({ done: true })
    const fired = result.current
    expect(fired).not.toBeNull()
    // Let it settle.
    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(result.current).toBeNull()
    // Now reverse - should remain null.
    rerender({ done: false })
    expect(result.current).toBeNull()
  })

  it('respects a custom duration', () => {
    const { result, rerender } = renderHook(
      ({ done }) => useJustCompleted(done, 250),
      { initialProps: { done: false } }
    )
    rerender({ done: true })
    expect(result.current).not.toBeNull()
    // Just before the cutoff - still active.
    act(() => {
      vi.advanceTimersByTime(240)
    })
    expect(result.current).not.toBeNull()
    // Past the cutoff - null.
    act(() => {
      vi.advanceTimersByTime(20)
    })
    expect(result.current).toBeNull()
  })
})
