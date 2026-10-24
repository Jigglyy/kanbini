import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'

// Right-click / button-anchored context menu. Opens at the pointer in a
// <body> portal (never clipped), clamped to the viewport, closes on
// outside-click / Escape / scroll. `children` gets an `open(e)` to bind
// to onContextMenu (cards) or a button onClick (the list pencil).

/** Gap kept between the menu and every window edge, in px. */
const MARGIN = 8

export function ContextMenu({
  children,
  menu,
  width = 220
}: {
  children: (open: (e: MouseEvent) => void) => ReactNode
  menu: (close: () => void) => ReactNode
  width?: number
}) {
  // Two-phase open: `raw` stores the pointer coords as-clicked; we paint
  // the panel there invisibly, then measure its real size in a layout
  // effect and write the clamped position into `pos` before revealing.
  // This replaces the previous hardcoded `estH = 340` guess, which
  // under-counted the tall card menu (Cover / labels / archive / move /
  // duplicate / delete) and let it run past the bottom edge when the
  // click was low. Same treatment for the right edge - measured width
  // beats the `width` prop in case rendered size ever drifts (border /
  // future scrollbar / etc.).
  const [raw, setRaw] = useState<{ x: number; y: number } | null>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const open = (e: MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setPos(null)
    setRaw({ x: e.clientX, y: e.clientY })
  }
  const close = (): void => {
    setRaw(null)
    setPos(null)
  }

  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!raw || !panel) return
    const place = (): void => {
      const rect = panel.getBoundingClientRect()
      const x = Math.max(
        MARGIN,
        Math.min(raw.x, window.innerWidth - rect.width - MARGIN)
      )
      const y = Math.max(
        MARGIN,
        Math.min(raw.y, window.innerHeight - rect.height - MARGIN)
      )
      setPos((p) => (p && p.x === x && p.y === y ? p : { x, y }))
    }
    place()
    // Re-clamp whenever the panel changes size while open. Menus grow in
    // place (the inline delete confirm swaps a one-line row for a taller
    // block); measuring only at open let a menu clamped to the bottom
    // edge push its confirm button off the window (GitHub issue #1).
    // The observer fires after layout and before paint, so the overflow
    // never shows.
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(place)
    ro.observe(panel)
    return () => ro.disconnect()
  }, [raw])

  useEffect(() => {
    if (!raw) return
    const onDown = (e: globalThis.MouseEvent): void => {
      if (!panelRef.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    // A page scroll moves the anchor out from under the menu, so it
    // closes; the menu scrolling its OWN overflow (taller than the
    // window) must not.
    const onScroll = (e: Event): void => {
      const inPanel =
        e.target instanceof Node && panelRef.current?.contains(e.target)
      if (!inPanel) close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [raw])

  return (
    <>
      {children(open)}
      {raw &&
        createPortal(
          <div
            ref={panelRef}
            data-overlay="context-menu"
            style={{
              position: 'fixed',
              top: pos?.y ?? raw.y,
              left: pos?.x ?? raw.x,
              width,
              // Never taller than the window: on a short window the
              // menu scrolls inside itself so its last rows (Delete)
              // stay reachable.
              maxHeight: `calc(100vh - ${MARGIN * 2}px)`,
              overflowY: 'auto',
              // Paint invisibly for one frame so the layout effect can
              // measure the real rect, then reveal at the clamped
              // position. `visibility: hidden` keeps the element in flow
              // so getBoundingClientRect returns real dimensions
              // (`display: none` would give zeroes).
              visibility: pos ? 'visible' : 'hidden'
            }}
            // `*:shrink-0`: once the height is capped, a flex column
            // would squash its rows to fit instead of overflowing.
            // `scroll-py-1.5` matches the padding so `revealOnMount`
            // stops with the padding showing, not flush to the edge.
            className="z-50 flex flex-col gap-0.5 rounded-md border border-border bg-card p-1.5 text-sm text-foreground shadow-xl scroll-py-1.5 *:shrink-0"
          >
            {menu(close)}
          </div>,
          document.body
        )}
    </>
  )
}

/** Ref for a block that swaps in below the fold of a scrolling menu
 *  (an inline delete confirm): scrolls it into view on mount. Module
 *  level so the ref identity is stable and it only fires on mount. */
export const revealOnMount = (el: HTMLElement | null): void => {
  el?.scrollIntoView?.({ block: 'nearest' })
}

/** A standard clickable row inside a context menu. */
export function MenuItem({
  onClick,
  children,
  danger
}: {
  onClick: () => void
  children: ReactNode
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded px-2 py-1.5 text-left text-sm hover:bg-muted ${
        danger ? 'text-red-400 hover:text-red-300' : 'text-foreground'
      }`}
    >
      {children}
    </button>
  )
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  )
}

export function MenuSep() {
  return <div className="my-1 h-px bg-border" />
}
