import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Maximize,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import { humanSize } from '../../lib/media'
import {
  ZOOM_STEP,
  clampView,
  doubleClickScale,
  fittedView,
  zoomTo,
  type Size,
  type View
} from '../../lib/viewer-math'

// Full-window viewer for a card's images and videos (replaces the old
// image lightbox). Images: wheel zooms toward the cursor, drag pans,
// double-click switches between fit and 100%, +/- / 0 / 1 keys, pixels
// stay sharp past 100% and a checkerboard shows through transparency.
// Left / right step through the card's other media. Videos play with
// the browser's controls. Body-portaled so it sits above the card
// detail; `data-overlay` so the Modal and App leave Escape to it.

export interface MediaItem {
  id: string
  src: string
  name: string
  kind: 'image' | 'video'
  size: number | null
}

/** Shows through transparent pixels. Sized per render so the squares
 *  stay the same on screen whatever the zoom. */
const CHECKER =
  'conic-gradient(#9ca3af 25%, #e5e7eb 0 50%, #9ca3af 0 75%, #e5e7eb 0)'
/** An SVG without its own size reports 0 x 0; draw it at this. */
const FALLBACK_SIZE: Size = { w: 512, h: 512 }

export function MediaViewer({
  items,
  startIndex,
  onClose,
  onOpenInApp
}: {
  items: MediaItem[]
  startIndex: number
  onClose: () => void
  /** "Open in default app" for the current item; resolves to the reason
   *  when it couldn't. Omitted where the platform can't (web edition). */
  onOpenInApp?: (id: string) => Promise<string | null>
}) {
  const [index, setIndex] = useState(() =>
    Math.min(Math.max(startIndex, 0), Math.max(items.length - 1, 0))
  )
  const item = items[index]
  const stageRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<Size>({ w: 0, h: 0 })
  const [nat, setNat] = useState<Size | null>(null)
  const [view, setView] = useState<View | null>(null)
  // While true the image re-fits when the window resizes; any zoom or pan
  // by hand turns it off until the next item.
  const fitted = useRef(true)
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(
    null
  )

  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = (): void => setBox({ w: el.clientWidth, h: el.clientHeight })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const [openError, setOpenError] = useState<string | null>(null)
  useEffect(() => {
    setNat(null)
    setView(null)
    setOpenError(null)
    fitted.current = true
  }, [index])

  useEffect(() => {
    if (!nat || box.w === 0) return
    setView((v) => (fitted.current || !v ? fittedView(nat, box) : clampView(v, nat, box)))
  }, [nat, box])

  const isImage = item?.kind === 'image'
  const center = { x: box.w / 2, y: box.h / 2 }

  const zoom = useCallback(
    (scale: number, at: { x: number; y: number }) => {
      if (!nat) return
      fitted.current = false
      setView((v) => (v ? zoomTo(v, scale, at, nat, box) : v))
    },
    [nat, box]
  )
  const fit = useCallback(() => {
    if (!nat) return
    fitted.current = true
    setView(fittedView(nat, box))
  }, [nat, box])

  const go = useCallback(
    (step: number) => {
      if (items.length < 2) return
      setIndex((i) => (i + step + items.length) % items.length)
    },
    [items.length]
  )

  // Capture phase, before the card detail's own Escape listener (the
  // viewer opens from inside it), and stopped so a key meant for the
  // viewer never also reaches the board's shortcuts.
  const viewRef = useRef(view)
  viewRef.current = view
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const v = viewRef.current
      let handled = true
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') go(-1)
      else if (e.key === 'ArrowRight') go(1)
      else if (isImage && v && (e.key === '+' || e.key === '=')) zoom(v.scale * ZOOM_STEP, center)
      else if (isImage && v && e.key === '-') zoom(v.scale / ZOOM_STEP, center)
      else if (isImage && e.key === '0') fit()
      else if (isImage && e.key === '1') zoom(1, center)
      else handled = false
      if (handled) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    document.addEventListener('keydown', onKey, true)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = prev
    }
  })

  // Wheel zoom toward the cursor. A native listener: React's is passive,
  // so it couldn't stop the page from scrolling.
  useEffect(() => {
    const el = stageRef.current
    if (!el || !isImage) return
    const onWheel = (e: WheelEvent): void => {
      const v = viewRef.current
      if (!v) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      zoom(v.scale * Math.exp(-e.deltaY * 0.0015), { x: e.clientX - r.left, y: e.clientY - r.top })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [isImage, zoom])

  if (!item) return null

  const point = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = stageRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const zoomPct = view ? Math.round(view.scale * 100) : null
  const info = [
    nat && nat.w > 0 ? `${nat.w} × ${nat.h}` : null,
    item.size != null ? humanSize(item.size) : null
  ]
    .filter(Boolean)
    .join(' · ')

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={item.name}
      data-overlay="media-viewer"
      className="fixed inset-0 z-50 flex flex-col bg-black/90 text-white backdrop-blur-sm"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 px-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" title={item.name}>
            {item.name}
          </div>
          {openError ? (
            <div role="alert" className="truncate text-xs text-red-300">
              {openError}
            </div>
          ) : (
            info && <div className="truncate text-xs text-white/60">{info}</div>
          )}
        </div>
        {items.length > 1 && (
          <span className="px-2 text-xs tabular-nums text-white/70">
            {index + 1} / {items.length}
          </span>
        )}
        {isImage && (
          <>
            <ToolButton
              label="Zoom out"
              onClick={() => view && zoom(view.scale / ZOOM_STEP, center)}
            >
              <ZoomOut className="size-4" />
            </ToolButton>
            <button
              type="button"
              onClick={() => zoom(1, center)}
              title="Actual size (1)"
              aria-label="Actual size"
              className="w-14 rounded px-1 py-1 text-center text-xs tabular-nums text-white/80 hover:bg-white/10 hover:text-white"
            >
              {zoomPct != null ? `${zoomPct}%` : '-'}
            </button>
            <ToolButton
              label="Zoom in"
              onClick={() => view && zoom(view.scale * ZOOM_STEP, center)}
            >
              <ZoomIn className="size-4" />
            </ToolButton>
            <ToolButton label="Fit to window" onClick={fit}>
              <Maximize className="size-4" />
            </ToolButton>
          </>
        )}
        {onOpenInApp && (
          <ToolButton
            label="Open in default app"
            onClick={() => void onOpenInApp(item.id).then(setOpenError)}
          >
            <ExternalLink className="size-4" />
          </ToolButton>
        )}
        <ToolButton label="Close" onClick={onClose}>
          <X className="size-5" />
        </ToolButton>
      </div>

      <div
        ref={stageRef}
        data-testid="media-stage"
        className={`relative min-h-0 flex-1 overflow-hidden ${
          isImage ? 'cursor-grab active:cursor-grabbing' : 'flex items-center justify-center p-4'
        }`}
        onPointerDown={(e) => {
          if (e.button !== 0 || !view) return
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }
          e.currentTarget.setPointerCapture?.(e.pointerId)
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d || !nat || !isImage) return
          const dx = e.clientX - d.x
          const dy = e.clientY - d.y
          if (!d.moved && Math.hypot(dx, dy) < 3) return
          d.moved = true
          fitted.current = false
          setView((v) => (v ? clampView({ ...v, x: d.vx + dx, y: d.vy + dy }, nat, box) : v))
        }}
        onPointerUp={() => {
          // A drag never counts as the click that closes below.
          if (drag.current?.moved) {
            const stop = (ev: Event): void => ev.stopPropagation()
            window.addEventListener('click', stop, { capture: true, once: true })
            // The click follows pointerup in the same task; if none does
            // (released outside the window), don't eat a later one.
            setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 0)
          }
          drag.current = null
        }}
        onClick={(e) => {
          // A click on the empty stage around the media closes, like the
          // old lightbox's backdrop.
          if (e.target === e.currentTarget) onClose()
        }}
        onDoubleClick={(e) => {
          if (!isImage || !view || !nat) return
          zoom(doubleClickScale(view, nat, box), point(e))
        }}
      >
        {isImage ? (
          <img
            key={item.id}
            src={item.src}
            alt={item.name}
            draggable={false}
            onLoad={(e) => {
              const img = e.currentTarget
              setNat(
                img.naturalWidth > 0 && img.naturalHeight > 0
                  ? { w: img.naturalWidth, h: img.naturalHeight }
                  : FALLBACK_SIZE
              )
            }}
            className="absolute left-0 top-0 max-w-none select-none shadow-2xl"
            style={{
              width: nat?.w,
              height: nat?.h,
              transformOrigin: '0 0',
              transform: view ? `translate(${view.x}px, ${view.y}px) scale(${view.scale})` : undefined,
              visibility: view ? 'visible' : 'hidden',
              imageRendering: view && view.scale > 1 ? 'pixelated' : undefined,
              backgroundImage: CHECKER,
              backgroundSize: view ? `${16 / view.scale}px ${16 / view.scale}px` : '16px 16px'
            }}
          />
        ) : (
          <video
            key={item.id}
            src={item.src}
            controls
            autoPlay
            aria-label={item.name}
            onLoadedMetadata={(e) =>
              setNat({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })
            }
            className="max-h-full max-w-full rounded-md shadow-2xl"
          />
        )}
        {items.length > 1 && (
          <>
            <StepButton side="left" label="Previous" onClick={() => go(-1)}>
              <ChevronLeft className="size-6" />
            </StepButton>
            <StepButton side="right" label="Next" onClick={() => go(1)}>
              <ChevronRight className="size-6" />
            </StepButton>
          </>
        )}
      </div>
    </div>,
    document.body
  )
}

function ToolButton({
  label,
  onClick,
  children
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="rounded p-1.5 text-white/80 hover:bg-white/10 hover:text-white"
    >
      {children}
    </button>
  )
}

function StepButton({
  side,
  label,
  onClick,
  children
}: {
  side: 'left' | 'right'
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      className={`absolute top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white/80 hover:bg-black/70 hover:text-white ${
        side === 'left' ? 'left-3' : 'right-3'
      }`}
    >
      {children}
    </button>
  )
}
