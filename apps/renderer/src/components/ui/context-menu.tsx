import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight } from 'lucide-react'

// Right-click / button-anchored context menu. Opens at the pointer in a
// <body> portal (never clipped), clamped to the viewport, closes on
// outside-click / Escape / scroll. `children` gets an `open(e)` to bind
// to onContextMenu (cards) or a button onClick (the list pencil).
//
// Long menus group their options into fly-outs (`SubMenu`): a row shows
// the current value and opens a second panel beside the menu. They work
// like desktop menus: hover a row for a moment (or click it) to open its
// fly-out, crossing other rows on the way in doesn't switch it right
// away, the fly-out flips to the left near the window's right edge, and
// Right / Left arrows (or Enter / Escape) open and close it from the
// keyboard. One fly-out is open at a time.

/** Gap kept between the menu and every window edge, in px. */
const MARGIN = 8
/** How long the pointer rests on a fly-out row before it opens, and how
 *  long it can cross other rows on its way into an open fly-out. */
const SUBMENU_OPEN_MS = 150
const SUBMENU_CLOSE_MS = 300

/** Marks fly-out panels: they're portaled outside the menu's own panel,
 *  but clicks and scrolls in them are still inside the menu. */
const SUBMENU_ATTR = 'data-submenu-panel'

interface SubmenuState {
  openId: string | null
  setOpen: (id: string | null) => void
  /** Close the open fly-out soon, unless the pointer reaches it (or
   *  another fly-out row) first. */
  scheduleClose: () => void
  cancelClose: () => void
}
const SubmenuCtx = createContext<SubmenuState | null>(null)

const inMenu = (panel: HTMLElement | null, target: EventTarget | null): boolean =>
  target instanceof Node &&
  (!!panel?.contains(target) ||
    (target instanceof Element && !!target.closest(`[${SUBMENU_ATTR}]`)))

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
  const [openSub, setOpenSub] = useState<string | null>(null)
  // Mirror for the document Escape listener (bound once per open).
  const openSubRef = useRef<string | null>(null)
  openSubRef.current = openSub
  const subCloseTimer = useRef<number | undefined>(undefined)
  const cancelSubClose = (): void => window.clearTimeout(subCloseTimer.current)
  const submenus: SubmenuState = {
    openId: openSub,
    setOpen: (id) => {
      cancelSubClose()
      setOpenSub(id)
    },
    scheduleClose: () => {
      cancelSubClose()
      subCloseTimer.current = window.setTimeout(
        () => setOpenSub(null),
        SUBMENU_CLOSE_MS
      )
    },
    cancelClose: cancelSubClose
  }
  useEffect(() => () => cancelSubClose(), [])

  const open = (e: MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setPos(null)
    setOpenSub(null)
    setRaw({ x: e.clientX, y: e.clientY })
  }
  const close = (): void => {
    cancelSubClose()
    setOpenSub(null)
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
    // Clicks inside a fly-out are inside the menu too.
    const onDown = (e: globalThis.MouseEvent): void => {
      if (!inMenu(panelRef.current, e.target)) close()
    }
    // Escape closes an open fly-out first (even one opened by hovering,
    // with focus still in the menu), then the menu.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (openSubRef.current) setOpenSub(null)
      else close()
    }
    // A page scroll moves the anchor out from under the menu, so it
    // closes; the menu (or a fly-out) scrolling its OWN overflow (taller
    // than the window) must not.
    const onScroll = (e: Event): void => {
      if (!inMenu(panelRef.current, e.target)) close()
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
            // Resting on a plain row (or the padding) closes an open
            // fly-out after a beat, like a desktop menu; fly-out rows
            // handle their own hover. React bubbles events out of the
            // portaled fly-out to here too, so moving inside it is skipped.
            onPointerOver={(e) => {
              const t = e.target as Element
              if (openSub && !t.closest(`[data-submenu-trigger], [${SUBMENU_ATTR}]`)) {
                submenus.scheduleClose()
              }
            }}
            // A fly-out is placed against its row; scrolling the menu
            // would leave it hanging next to a different row.
            onScroll={() => setOpenSub(null)}
          >
            <SubmenuCtx.Provider value={submenus}>{menu(close)}</SubmenuCtx.Provider>
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

/** A menu row that opens a fly-out with more options: `label` on the
 *  left, the current `value` muted on the right, then a chevron. The
 *  fly-out (`children`) opens beside the menu on hover (after a short
 *  pause), on click, or with Right / Enter / Space; Left or Escape closes
 *  it again (Escape doesn't close the whole menu). `id` is unique within
 *  the menu. Must render inside a ContextMenu. */
export function SubMenu({
  id,
  label,
  value,
  icon,
  width = 220,
  children
}: {
  id: string
  label: string
  value?: ReactNode
  icon?: ReactNode
  width?: number
  children: ReactNode
}) {
  const ctx = useContext(SubmenuCtx)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const openTimer = useRef<number | undefined>(undefined)
  const [focusFirst, setFocusFirst] = useState(false)
  useEffect(() => () => window.clearTimeout(openTimer.current), [])
  if (!ctx) throw new Error('SubMenu must be used inside a ContextMenu')
  const open = ctx.openId === id
  const openNow = (viaKeyboard: boolean): void => {
    window.clearTimeout(openTimer.current)
    setFocusFirst(viaKeyboard)
    ctx.setOpen(id)
  }
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-submenu-trigger={id}
        aria-haspopup="menu"
        aria-expanded={open}
        onPointerEnter={() => {
          ctx.cancelClose()
          if (open) return
          window.clearTimeout(openTimer.current)
          openTimer.current = window.setTimeout(() => openNow(false), SUBMENU_OPEN_MS)
        }}
        onPointerLeave={() => window.clearTimeout(openTimer.current)}
        // Click always opens (never toggles): a hover usually opened it a
        // moment before the click lands.
        onClick={() => openNow(false)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            openNow(true)
          }
        }}
        className={`flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-foreground hover:bg-muted ${
          open ? 'bg-muted' : ''
        }`}
      >
        {icon && (
          <span className="inline-flex w-4 shrink-0 justify-center text-muted-foreground">
            {icon}
          </span>
        )}
        <span className="shrink-0">{label}</span>
        <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">
          {value}
        </span>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </button>
      {open && (
        <SubmenuPanel
          anchor={triggerRef}
          width={width}
          label={label}
          focusFirst={focusFirst}
          onPointerEnter={ctx.cancelClose}
          onBack={() => {
            ctx.setOpen(null)
            triggerRef.current?.focus()
          }}
        >
          {children}
        </SubmenuPanel>
      )}
    </>
  )
}

/** The fly-out panel: body-portaled like the menu (the menu's own
 *  `overflow-y: auto` would clip anything positioned outside it), placed
 *  beside its row, flipped left when it would run off the right edge,
 *  clamped to the window and scrolling if taller. */
function SubmenuPanel({
  anchor,
  width,
  label,
  focusFirst,
  onPointerEnter,
  onBack,
  children
}: {
  anchor: RefObject<HTMLButtonElement | null>
  width: number
  label: string
  focusFirst: boolean
  onPointerEnter: () => void
  onBack: () => void
  children: ReactNode
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  useLayoutEffect(() => {
    const panel = panelRef.current
    const row = anchor.current
    if (!panel || !row) return
    const place = (): void => {
      const r = row.getBoundingClientRect()
      const p = panel.getBoundingClientRect()
      // Horizontally against the MENU's edge (the row sits inside its
      // padding), vertically with its first item level with the row (the
      // panel's padding is 6 px); flip left of the menu when there's no
      // room on the right.
      const m = row.closest('[data-overlay="context-menu"]')?.getBoundingClientRect() ?? r
      let x = m.right + 2
      if (x + p.width > window.innerWidth - MARGIN) x = m.left - p.width - 2
      x = Math.max(MARGIN, x)
      const y = Math.max(
        MARGIN,
        Math.min(r.top - 6, window.innerHeight - p.height - MARGIN)
      )
      setPos((prev) => (prev && prev.x === x && prev.y === y ? prev : { x, y }))
    }
    place()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(place)
    ro.observe(panel)
    return () => ro.disconnect()
  }, [anchor])

  // Opened from the keyboard: move focus into the fly-out.
  useEffect(() => {
    if (!focusFirst || !pos) return
    panelRef.current
      ?.querySelector<HTMLElement>('button:not([disabled]), input, select, [tabindex]')
      ?.focus()
  }, [focusFirst, pos])

  return createPortal(
    <div
      ref={panelRef}
      {...{ [SUBMENU_ATTR]: '' }}
      data-overlay="context-submenu"
      role="menu"
      aria-label={label}
      onPointerEnter={onPointerEnter}
      onKeyDown={(e) => {
        const typing = (e.target as Element).closest('input, textarea, select')
        // Escape / Left back out to the menu row. Escape must not reach
        // the menu's own listener, which would close the whole menu.
        if (e.key === 'Escape' || (e.key === 'ArrowLeft' && !typing)) {
          e.preventDefault()
          e.stopPropagation()
          onBack()
        }
      }}
      style={{
        position: 'fixed',
        top: pos?.y ?? 0,
        left: pos?.x ?? 0,
        width,
        maxHeight: `calc(100vh - ${MARGIN * 2}px)`,
        overflowY: 'auto',
        visibility: pos ? 'visible' : 'hidden'
      }}
      className="z-50 flex flex-col gap-0.5 rounded-md border border-border bg-card p-1.5 text-sm text-foreground shadow-xl scroll-py-1.5 *:shrink-0"
    >
      {children}
    </div>,
    document.body
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
