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
    if (!raw || !panelRef.current) return
    const margin = 8
    const rect = panelRef.current.getBoundingClientRect()
    const x = Math.max(
      margin,
      Math.min(raw.x, window.innerWidth - rect.width - margin)
    )
    const y = Math.max(
      margin,
      Math.min(raw.y, window.innerHeight - rect.height - margin)
    )
    setPos({ x, y })
  }, [raw])

  useEffect(() => {
    if (!raw) return
    const onDown = (e: globalThis.MouseEvent): void => {
      if (!panelRef.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
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
              // Paint invisibly for one frame so the layout effect can
              // measure the real rect, then reveal at the clamped
              // position. `visibility: hidden` keeps the element in flow
              // so getBoundingClientRect returns real dimensions
              // (`display: none` would give zeroes).
              visibility: pos ? 'visible' : 'hidden'
            }}
            className="z-50 flex flex-col gap-0.5 rounded-md border border-border bg-card p-1.5 text-sm text-foreground shadow-xl"
          >
            {menu(close)}
          </div>,
          document.body
        )}
    </>
  )
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
