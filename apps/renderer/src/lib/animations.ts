import { useEffect, useRef, useState } from 'react'

// Renderer-only animation triggers. These hooks return short-lived
// flags that a component can pass to className conditionals so a CSS
// keyframe runs once on a state edge. All animations are gated on
// `prefers-reduced-motion: no-preference` at the CSS-class level
// (see index.css), so the hooks fire regardless of OS setting -
// reduced-motion users just see the static end state.

/** Returns `'a'` / `'b'` for ~`durationMs` after `completed` flips
 *  false → true, alternating on every fire; `null` at rest. Doesn't
 *  fire on the reverse transition (uncomplete is silent), or on
 *  first mount when the card is already completed (so a board
 *  refetch doesn't pop every done card).
 *
 *  The a/b alternation is the same trick `kanbini-shake-a/b` uses:
 *  the browser only restarts a CSS animation when the computed
 *  `animation` value changes, so re-applying the SAME class name on
 *  a rapid flip would do nothing. Two class names that resolve to
 *  two identically-shaped @keyframes restart cleanly. Without this,
 *  spamming complete/incomplete would show the animation on the
 *  first edge and silently skip the rest. */
export function useJustCompleted(
  completed: boolean,
  durationMs = 700
): 'a' | 'b' | null {
  const [tick, setTick] = useState(0)
  const [active, setActive] = useState(false)
  const prev = useRef(completed)
  useEffect(() => {
    const wasIncomplete = !prev.current
    prev.current = completed
    if (!(wasIncomplete && completed)) return
    setTick((t) => t + 1)
    setActive(true)
    const t = window.setTimeout(() => setActive(false), durationMs)
    return () => window.clearTimeout(t)
  }, [completed, durationMs])
  if (!active) return null
  return tick % 2 === 1 ? 'a' : 'b'
}
