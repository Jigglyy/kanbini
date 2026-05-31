import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'

// One popover for every menu. Rendered in a portal at <body> so it is
// never clipped by a list's overflow or the board's scroll container
// (fixes the out-of-bounds bug), clamped into the viewport, and closed
// on outside-click / Escape. Children get a `close()` to call after an
// action so menus dismiss themselves.

export function Popover({
  trigger,
  children,
  width = 240,
  align = 'left'
}: {
  trigger: (api: { open: boolean; toggle: () => void }) => ReactNode
  children: (close: () => void) => ReactNode
  width?: number
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const close = (): void => setOpen(false)

  const place = (): void => {
    const t = triggerRef.current?.getBoundingClientRect()
    if (!t) return
    const margin = 8
    const estH = panelRef.current?.offsetHeight ?? 280
    let left = align === 'right' ? t.right - width : t.left
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin))
    let top = t.bottom + 4
    if (top + estH + margin > window.innerHeight) {
      top = Math.max(margin, t.top - 4 - estH)
    }
    setPos({ top, left })
  }

  const toggle = (): void => {
    if (!open) place()
    setOpen((o) => !o)
  }

  // Re-measure once mounted (estH guess → real height) and on changes.
  useLayoutEffect(() => {
    if (open) place()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (
        !panelRef.current?.contains(target) &&
        !triggerRef.current?.contains(target)
      ) {
        close()
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    const reposition = (): void => place()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [open])

  return (
    <>
      <span ref={triggerRef} className="inline-flex">
        {trigger({ open, toggle })}
      </span>
      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            data-overlay="popover"
            style={{ position: 'fixed', top: pos.top, left: pos.left, width }}
            className="z-50 flex flex-col gap-2 rounded-md border border-border bg-card p-3 text-foreground shadow-lg"
          >
            {children(close)}
          </div>,
          document.body
        )}
    </>
  )
}
