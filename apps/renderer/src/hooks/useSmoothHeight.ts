import { useEffect, useRef } from 'react'

// Tween an element's content-driven height changes instead of letting
// them snap. The card preview grows when a hover-revealed checkbox
// column shrinks the title's width enough to wrap an extra line; CSS
// can't `transition` an `auto` height (the specified value never
// changes - only the resolved one does), so we watch the rendered
// height with a ResizeObserver and, on each change, run a one-shot Web
// Animations height tween from the previous height to the new one. The
// element is already AT the new (auto) height when the observer fires,
// so the keyframes briefly drive it back to the old height and glide
// forward - the host's `overflow-hidden` clips the not-yet-revealed
// line during the grow (and the trailing line during a shrink), which
// is what reads as "buttery."
//
// THE OFF-SCREEN SCROLL JUMP (the load-bearing fix): when a card that is
// scrolled ABOVE the viewport changes height (you scrolled down, then a
// card up top un-hovers and its title un-wraps, or you re-hover and it
// wraps), the reflow shifts every following element - i.e. the entire
// visible region - by the height delta. `scrollTop` does not change, so
// it isn't a scroll event and native scroll-anchoring doesn't absorb it;
// the content just visibly jumps and settles. Measured at 20px (one
// line) and it happens with OR without the tween, so animating isn't the
// cause. The fix is a manual scroll anchor: when the resizing element is
// fully above the scroll container's visible top, add the height delta to
// the container's `scrollTop` in the same frame so nothing visibly moves,
// and skip the tween (the card is off-screen - its glide is invisible).
//
// THE PENDING-FRAME PIN: when the observer fires for a VISIBLE card, the
// browser has already laid it out at its new `to` height. `el.animate()`
// is pending for a frame (its start time resolves on the next tick), so
// without help the element paints at `to` for that one frame before the
// active phase pulls it to `from`. We set `el.style.height = from`
// synchronously before animating so the pending frame already shows
// `from` and the height only eases from -> to. A `fill: 'forwards'`
// holds `to` at the end; onSettle clears the inline height (back to auto)
// then cancels the fill, in that order, so the pin is never exposed.
//
// CRITICAL: animating `height` is a layout change, so the tween's own
// per-frame heights fire the ResizeObserver again. Left unguarded that
// is an infinite feedback loop (observe -> animate -> observe the
// animation -> animate again...) - the element never settles, which
// also makes Playwright treat the card as perpetually "not stable." The
// `selfResizing` flag makes us ignore the observer callbacks our own
// tween produces.
//
// But ignoring the observer mid-tween also hides a GENUINE content
// change that lands while we animate - e.g. hovering card A (grow
// starts) then moving to card B before the grow finishes (A's content
// shrinks back). The shrink is ignored, the grow plays to its target,
// and when it ends the element releases to its now-smaller natural
// height in one frame: a visible SNAP. So on finish we compare the
// height we animated TO against the element's real (post-release)
// height; if they differ, the content moved under us and we tween the
// remaining distance instead of snapping. This converges (each finish
// re-checks) and never loops on synthetic frames (those stay ignored
// while `selfResizing`).
//
// `enabled` gates the tween off for states where a snap is correct or a
// mid-flight animation would corrupt a measurement (dnd-kit reads the
// card's bounding rect at drag start; an in-progress height animation
// would size the drag overlay wrong). Flipping it off also cancels any
// running tween so the element resolves to its true height immediately.

/** Duration of the height glide. Matches the card's checkbox-reveal +
 *  drop animations (200 ms) so the width reveal that triggers the wrap
 *  and the height grow it causes feel like one motion. */
const HEIGHT_TWEEN_MS = 200

/** Nearest scrollable ancestor (overflow-y auto/scroll), or null. Used
 *  for the off-screen scroll-anchor compensation. */
function findScrollParent(node: HTMLElement | null): HTMLElement | null {
  let n = node?.parentElement ?? null
  while (n) {
    const oy = getComputedStyle(n).overflowY
    if (oy === 'auto' || oy === 'scroll') return n
    n = n.parentElement
  }
  return null
}

export function useSmoothHeight(
  ref: React.RefObject<HTMLElement | null>,
  enabled: boolean
): void {
  const prevHeight = useRef<number | null>(null)
  const anim = useRef<Animation | null>(null)
  // Height the in-flight tween is animating TO (null when idle). Used on
  // finish to detect a content change that the observer ignored.
  const targetHeight = useRef<number | null>(null)
  const selfResizing = useRef(false)
  // Resolved scroll container: undefined = not looked up yet, null = none.
  const scrollParent = useRef<HTMLElement | null | undefined>(undefined)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  // Drop a running tween without its end handler re-arming anything -
  // used when superseding a tween and when disabling mid-flight. Also
  // releases the inline height pin so the element falls back to its true
  // auto height (a left-behind pin would freeze the card's size).
  const cancelAnim = (): void => {
    const a = anim.current
    if (a) {
      a.onfinish = null
      a.oncancel = null
      a.cancel()
      anim.current = null
    }
    const el = ref.current
    if (el) el.style.height = ''
    selfResizing.current = false
    targetHeight.current = null
  }

  useEffect(() => {
    const el = ref.current
    // JSDOM (unit tests) and any non-DOM env lack these APIs - bail so
    // the component renders fine; the tween is pure visual polish.
    if (!el || typeof ResizeObserver === 'undefined' || !el.animate) return

    function startTween(from: number, to: number): void {
      cancelAnim()
      selfResizing.current = true
      targetHeight.current = to
      // Pin the start height synchronously so the just-resolved natural
      // (`to`) height never paints for the pending frame - see the
      // PENDING-FRAME PIN note at the top of the file.
      el!.style.height = `${from}px`
      const a = el!.animate(
        [{ height: `${from}px` }, { height: `${to}px` }],
        // `fill: 'forwards'` holds `to` after the active phase so there's
        // no symmetric snap at the END before onSettle releases the pin.
        { duration: HEIGHT_TWEEN_MS, easing: 'ease-out', fill: 'forwards' }
      )
      anim.current = a
      a.onfinish = onSettle
      a.oncancel = onSettle
    }

    function onSettle(): void {
      const a = anim.current
      // Null the handlers before cancelling so a.cancel() below doesn't
      // re-enter onSettle via oncancel.
      if (a) {
        a.onfinish = null
        a.oncancel = null
      }
      anim.current = null
      const wasTarget = targetHeight.current
      // Release the inline pin + the forwards fill so the element resolves
      // to its true auto height again. Clear the inline height FIRST so
      // dropping the fill never exposes the pinned `from` for a frame.
      el!.style.height = ''
      if (a) a.cancel()
      const natural = el!.offsetHeight
      if (enabledRef.current && wasTarget != null && natural !== wasTarget) {
        // Content changed while we were animating (and the observer
        // ignored it) - finish the remaining distance smoothly from
        // where the tween left off instead of snapping.
        startTween(wasTarget, natural)
        return
      }
      selfResizing.current = false
      targetHeight.current = null
      prevHeight.current = natural
    }

    /** When the element is scrolled FULLY above the scroll container's
     *  visible top, its height change is a pure off-screen artifact: the
     *  reflow shifts the whole visible region by `delta` but none of the
     *  growth is itself visible. Add `delta` to the container's scrollTop
     *  in the same frame so visible content stays pinned, and report that
     *  the tween should be skipped (it's invisible). Returns false for any
     *  element that is even partly on screen - there the growth is real
     *  and should tween in place, so we deliberately do NOT touch scroll
     *  (compensating a straddling card fights its own visible motion).
     *  Guarded on a real container size so it's inert in JSDOM
     *  (clientHeight 0, rects all zero). */
    function compensateAboveFold(delta: number): boolean {
      if (scrollParent.current === undefined) {
        scrollParent.current = findScrollParent(el)
      }
      const sc = scrollParent.current
      if (!sc || sc.clientHeight === 0) return false
      const scTop = sc.getBoundingClientRect().top
      // Only when the element's BOTTOM is at/above the fold (fully off
      // screen above) is the change a pure artifact safe to fully cancel.
      if (el!.getBoundingClientRect().bottom > scTop) return false
      sc.scrollTop += delta
      return true
    }

    const ro = new ResizeObserver(() => {
      // Ignore the per-frame heights our own tween produces - reacting
      // to them is the infinite loop described above. A genuine change
      // that lands now is caught at the tween's onSettle instead.
      if (selfResizing.current) return
      const next = el.offsetHeight
      const last = prevHeight.current
      prevHeight.current = next
      // First measurement (mount): record, don't animate.
      if (last == null || last === next || !enabledRef.current) return
      // Fully-above-the-fold height change: compensate scroll so the
      // visible region doesn't jump, and skip the (invisible) tween. Any
      // on-screen (or straddling) card falls through and tweens in place.
      if (compensateAboveFold(next - last)) return
      startTween(last, next)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      cancelAnim()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref])

  // When the tween is disabled mid-flight (drag start / drop hold),
  // cancel it so the element snaps to its real height for measurement.
  useEffect(() => {
    if (!enabled && anim.current) {
      cancelAnim()
      const el = ref.current
      if (el) prevHeight.current = el.offsetHeight
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])
}
