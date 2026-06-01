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

/** Mount with the card nested in a scroll container, and stub geometry
 *  so the hook's scroll-anchor path is exercisable in JSDOM (which has
 *  no layout). `cardTop` is the card's viewport top; the container sits
 *  at top 100 with clientHeight 500. cardTop < 100 => above the fold. */
function mountWithScroll(opts: { cardTop: number; cardHeight: number }) {
  function ScrollHarness() {
    const ref = useRef<HTMLDivElement>(null)
    useSmoothHeight(ref, true)
    return (
      <div data-testid="sc" style={{ overflowY: 'auto' }}>
        <div ref={ref} />
      </div>
    )
  }
  const utils = render(<ScrollHarness />)
  const sc = utils.getByTestId('sc')
  const box = sc.firstChild as HTMLElement
  // Scroll container geometry. getComputedStyle in JSDOM reflects the
  // inline overflowY:auto, so findScrollParent picks `sc`.
  Object.defineProperty(sc, 'clientHeight', { configurable: true, get: () => 500 })
  let scrollTop = 1000
  Object.defineProperty(sc, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v
    }
  })
  sc.getBoundingClientRect = () =>
    ({ top: 100, bottom: 600, left: 0, right: 0, height: 500, width: 0, x: 0, y: 100 }) as DOMRect
  Object.defineProperty(box, 'offsetHeight', {
    configurable: true,
    get: () => currentHeight
  })
  // Card rect: top fixed by the test; bottom = top + current height.
  box.getBoundingClientRect = () =>
    ({
      top: opts.cardTop,
      bottom: opts.cardTop + currentHeight,
      left: 0,
      right: 0,
      height: currentHeight,
      width: 0,
      x: 0,
      y: opts.cardTop
    }) as DOMRect
  return { ...utils, box, sc, getScrollTop: () => scrollTop }
}

const KEYFRAMES = (from: number, to: number) => [
  { height: `${from}px` },
  { height: `${to}px` }
]
// `fill: 'forwards'` holds the to-height after the active phase so there
// is no end-snap before onSettle releases the inline pin (the start of
// the tween is handled by pinning el.style.height synchronously - see the
// "pins the start height" test below).
const OPTS = { duration: 200, easing: 'ease-out', fill: 'forwards' }

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

  it('pins the start height inline during the tween, releases it on settle', () => {
    // The scroll-snap fix: el.animate() is pending for a frame, so the
    // already-resolved natural height would paint once before the
    // animation applies. Pinning el.style.height = from synchronously
    // prevents that. On settle the pin is released back to auto.
    const { box } = mount(true)
    currentHeight = 40
    fireResize() // baseline
    currentHeight = 64
    fireResize() // grow -> tween starts with the start height pinned
    expect(box.style.height).toBe('40px')
    lastAnim!.onfinish!()
    expect(box.style.height).toBe('')
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

  it('a card fully above the fold compensates scrollTop and skips the tween', () => {
    // The "screen snaps up and fixes itself" bug: a card scrolled above
    // the viewport changes height, shifting the visible region. scrollTop
    // doesn't change on its own (not a scroll event), so the hook adds
    // the delta itself to keep visible content pinned, and skips the
    // now-invisible tween. Card top -50 + height 40 => bottom -10, both
    // above the container top (100): fully above the fold.
    const { getScrollTop } = mountWithScroll({ cardTop: -50, cardHeight: 40 })
    currentHeight = 40
    fireResize() // baseline
    currentHeight = 60 // grew by 20 while above the fold
    fireResize()
    expect(getScrollTop()).toBe(1020) // 1000 + (60 - 40)
    expect(animateSpy).not.toHaveBeenCalled() // invisible -> no tween
  })

  it('a card straddling the fold tweens in place and does NOT compensate', () => {
    // Top 80 is above the container top (100) but bottom (80 + 60 = 140)
    // is on screen. Part of the growth is genuinely visible, so cancelling
    // the full delta would fight that visible motion - we deliberately
    // leave scroll alone and just tween. (This is the "not fully fixed but
    // way better" edge the simplification targets.)
    const { getScrollTop } = mountWithScroll({ cardTop: 80, cardHeight: 40 })
    currentHeight = 40
    fireResize() // baseline
    currentHeight = 60
    fireResize()
    expect(getScrollTop()).toBe(1000) // untouched
    expect(animateSpy).toHaveBeenCalledTimes(1) // tweens in place
  })

  it('a fully-visible card tweens in place without touching scrollTop', () => {
    // Card top 200 is below the container top (100) -> on screen, so the
    // growth is visible: tween normally, never compensate scroll.
    const { getScrollTop } = mountWithScroll({ cardTop: 200, cardHeight: 40 })
    currentHeight = 40
    fireResize() // baseline
    currentHeight = 60
    fireResize()
    expect(getScrollTop()).toBe(1000) // untouched
    expect(animateSpy).toHaveBeenCalledTimes(1)
    expect(animateSpy).toHaveBeenCalledWith(KEYFRAMES(40, 60), OPTS)
  })
})
