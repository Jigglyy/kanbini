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
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  // Drop a running tween without its end handler re-arming anything -
  // used when superseding a tween and when disabling mid-flight. Only
  // touches refs, so the (per-render) closure is safe to capture once.
  const cancelAnim = (): void => {
    const a = anim.current
    if (a) {
      a.onfinish = null
      a.oncancel = null
      a.cancel()
      anim.current = null
    }
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
      const a = el!.animate(
        [{ height: `${from}px` }, { height: `${to}px` }],
        { duration: HEIGHT_TWEEN_MS, easing: 'ease-out' }
      )
      anim.current = a
      a.onfinish = onSettle
      a.oncancel = onSettle
    }

    function onSettle(): void {
      const wasTarget = targetHeight.current
      anim.current = null
      // The animation has released its hold, so offsetHeight is the
      // element's true (auto) height again.
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
