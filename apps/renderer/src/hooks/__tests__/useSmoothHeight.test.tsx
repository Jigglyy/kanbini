import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest'
import { useRef } from 'react'
import { cleanup, render } from '@testing-library/react'
import { useSmoothHeight } from '../useSmoothHeight'

// useSmoothHeight tweens a card's content-driven height changes (the
// hover checkbox reveal wrapping the title to a new line) instead of
// snapping. It leans on two browser APIs JSDOM doesn't ship -
// ResizeObserver + Element.animate - so we fake both: a ResizeObserver
// whose callback the test fires by hand, and an `animate` spy that
// hands back a fake Animation we can `onfinish`. `offsetHeight` is
// stubbed per-element off a shared `currentHeight` the test drives.
//
// The load-bearing case is the feedback-loop guard: animating `height`
// is itself a layout change, so the tween's own per-frame heights fire
// the observer again. Unguarded that loops forever (the bug that left
// cards perpetually "not stable" and timed out the drag e2e).

type Captured = { cb: ResizeObserverCallback }
let observers: Captured[] = []
let currentHeight = 0

interface FakeAnim {
  cancel: ReturnType<typeof vi.fn>
  onfinish: (() => void) | null
  oncancel: (() => void) | null
}
let lastAnim: FakeAnim | null = null
const animateSpy = vi.fn(() => {
  const a: FakeAnim = { cancel: vi.fn(), onfinish: null, oncancel: null }
  lastAnim = a
  return a as unknown as Animation
})

class FakeResizeObserver {
  cb: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb
  }
  observe(): void {
    observers.push({ cb: this.cb })
  }
  unobserve(): void {}
  disconnect(): void {
    observers = observers.filter((o) => o.cb !== this.cb)
  }
}

/** Fire every live observer's callback - the hook reads offsetHeight
 *  itself, so the entries passed here are irrelevant. */
function fireResize(): void {
  for (const o of observers) o.cb([], {} as ResizeObserver)
}

function Harness({ enabled }: { enabled: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useSmoothHeight(ref, enabled)
  return <div ref={ref} />
}

function mount(enabled = true) {
  const utils = render(<Harness enabled={enabled} />)
  const box = utils.container.firstChild as HTMLElement
  Object.defineProperty(box, 'offsetHeight', {
    configurable: true,
    get: () => currentHeight
  })
  return { ...utils, box }
}

const KEYFRAMES = (from: number, to: number) => [
  { height: `${from}px` },
  { height: `${to}px` }
]
const OPTS = { duration: 200, easing: 'ease-out' }

beforeEach(() => {
  observers = []
  currentHeight = 0
  lastAnim = null
  animateSpy.mockClear()
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  // JSDOM has no Element.animate - install the spy for the hook's guard
  // + its actual call.
  ;(HTMLElement.prototype as unknown as { animate: unknown }).animate =
    animateSpy
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate
})

describe('useSmoothHeight', () => {
  it('does not animate on the first measurement (records the baseline)', () => {
    const { box } = mount(true)
    currentHeight = 40
    fireResize()
    expect(animateSpy).not.toHaveBeenCalled()
    expect(box).toBeTruthy()
  })

  it('tweens from the previous height to the new one on a reflow', () => {
    mount(true)
    currentHeight = 40
    fireResize() // baseline
    currentHeight = 64
    fireResize() // grew by a line
    expect(animateSpy).toHaveBeenCalledTimes(1)
    expect(animateSpy).toHaveBeenCalledWith(KEYFRAMES(40, 64), OPTS)
  })

  it('ignores the resize events its own tween produces (no feedback loop)', () => {
    mount(true)
    currentHeight = 40
    fireResize()
    currentHeight = 64
    fireResize() // starts a tween -> selfResizing is now true
    animateSpy.mockClear()
    // The running tween drives intermediate heights; the observer fires
    // for each. None of these may start a fresh animation.
    currentHeight = 48
    fireResize()
    currentHeight = 56
    fireResize()
    currentHeight = 63
    fireResize()
    expect(animateSpy).not.toHaveBeenCalled()
  })

  it('resumes tweening after the previous one settles', () => {
    mount(true)
    currentHeight = 40
    fireResize()
    currentHeight = 64
    fireResize()
    // Settle: the WAAPI animation finishes, height is now its real value.
    lastAnim!.onfinish!()
    animateSpy.mockClear()
    currentHeight = 90
    fireResize()
    expect(animateSpy).toHaveBeenCalledTimes(1)
    // Baseline picked up from the settled height, not the stale 64-start.
    expect(animateSpy).toHaveBeenCalledWith(KEYFRAMES(64, 90), OPTS)
  })

  it('tweens the remaining distance instead of snapping when content shrinks mid-tween', () => {
    // The "switch between two cards quickly" bug: card A grows on hover,
    // then its content shrinks back when you move to card B before the
    // grow finishes. The shrink is ignored mid-tween (selfResizing), so
    // without a correction the grow would play to 64 and then SNAP to
    // the real 40 at the end.
    mount(true)
    currentHeight = 40
    fireResize() // baseline
    currentHeight = 64
    fireResize() // grow starts: animate(40 -> 64)
    expect(animateSpy).toHaveBeenCalledTimes(1)

    // Content shrinks back while the grow is still running - ignored.
    currentHeight = 40
    fireResize()
    expect(animateSpy).toHaveBeenCalledTimes(1)

    // Grow finishes: the element's real height is now 40, not the 64 we
    // animated to. onSettle catches the gap and glides the rest of the
    // way (64 -> 40) instead of snapping.
    lastAnim!.onfinish!()
    expect(animateSpy).toHaveBeenCalledTimes(2)
    expect(animateSpy).toHaveBeenLastCalledWith(KEYFRAMES(64, 40), OPTS)

    // The corrective tween settles cleanly (natural now matches target).
    lastAnim!.onfinish!()
    expect(animateSpy).toHaveBeenCalledTimes(2)
  })

  it('keeps correcting across multiple mid-tween changes, then settles (converges)', () => {
    // Content that keeps moving while each tween runs should be chased
    // smoothly (a fresh corrective tween per finish) and must eventually
    // settle once it holds still - never an endless loop on synthetic
    // frames.
    mount(true)
    currentHeight = 40
    fireResize() // baseline
    currentHeight = 64
    fireResize() // grow: animate(40 -> 64)
    expect(animateSpy).toHaveBeenCalledTimes(1)

    // Shrinks to 50 during the grow (ignored), grow ends -> correct to 50.
    currentHeight = 50
    fireResize()
    lastAnim!.onfinish!()
    expect(animateSpy).toHaveBeenCalledTimes(2)
    expect(animateSpy).toHaveBeenLastCalledWith(KEYFRAMES(64, 50), OPTS)

    // Grows to 72 during the correction (ignored), correction ends ->
    // correct again to 72.
    currentHeight = 72
    fireResize()
    lastAnim!.onfinish!()
    expect(animateSpy).toHaveBeenCalledTimes(3)
    expect(animateSpy).toHaveBeenLastCalledWith(KEYFRAMES(50, 72), OPTS)

    // Content now holds still: the next finish settles, no new tween.
    lastAnim!.onfinish!()
    expect(animateSpy).toHaveBeenCalledTimes(3)
  })

  it('never animates while disabled (drag in progress)', () => {
    mount(false)
    currentHeight = 40
    fireResize()
    currentHeight = 64
    fireResize()
    expect(animateSpy).not.toHaveBeenCalled()
  })

  it('cancels an in-flight tween when it is disabled mid-flight', () => {
    const { rerender } = mount(true)
    currentHeight = 40
    fireResize()
    currentHeight = 64
    fireResize()
    const running = lastAnim!
    // A drag starts -> enabled flips to false -> the tween is dropped so
    // the element resolves to its true height for dnd-kit to measure.
    rerender(<Harness enabled={false} />)
    expect(running.cancel).toHaveBeenCalled()
  })

  it('no-op reflow (same height) does not animate', () => {
    mount(true)
    currentHeight = 50
    fireResize()
    fireResize() // identical height
    expect(animateSpy).not.toHaveBeenCalled()
  })
})
