import { ZoomIn } from 'lucide-react'
import { Popover } from './ui/popover'
import { Tooltip } from './ui/tooltip'

// Continuous board-content zoom (50–200%). The chip lives in the
// app header next to Search / Settings; clicking it opens a popover
// with the slider + a Reset row. The applied transform is plain CSS
// `zoom` on a wrapper around <Board> (see App.tsx) - chrome stays
// 1:1 so the slider doesn't fight Ctrl/Cmd +/- (which zooms the
// whole window via Electron setZoomLevel).

export const ZOOM_MIN = 0.5
export const ZOOM_MAX = 2
/** Keyboard step (arrow keys), on a clean 5% grid. */
export const ZOOM_STEP = 0.05
// Within this radius of 1.0 the slider snaps to exactly 100% - a
// soft detent so the user can always grab "default" without nudging.
const SNAP_RADIUS = 0.04

// The track is LOGARITHMIC: equal distances are equal zoom factors, so
// 50% sits at the left end, 100% exactly in the middle and 200% at the
// right end, matching the three labels under it. (A linear 50..200
// track put 100% a third of the way along and 125% in the middle, under
// the "100%" label.) The range input works in track units 0..SLIDER_MAX
// - fine enough that every whole percentage has its own position - and
// these two functions convert.
export const SLIDER_MAX = 1000
const LOG_SPAN = Math.log(ZOOM_MAX / ZOOM_MIN)

const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, n))

/** Zoom factor -> track position (0..SLIDER_MAX), clamped. */
export function zoomToSlider(zoom: number): number {
  const t = Math.log(clamp(zoom, ZOOM_MIN, ZOOM_MAX) / ZOOM_MIN) / LOG_SPAN
  return Math.round(t * SLIDER_MAX)
}

/** Track position -> zoom factor, rounded to a whole percentage. */
export function sliderToZoom(pos: number): number {
  const z = ZOOM_MIN * Math.exp((clamp(pos, 0, SLIDER_MAX) / SLIDER_MAX) * LOG_SPAN)
  return Math.round(z * 100) / 100
}

/** Keyboard: the next value on the 5% grid in `dir`, clamped. From an
 *  off-grid value (a drag left it at 123%) the first step lands on the
 *  grid (125% up, 120% down) rather than at 128% / 118%. */
function keyStep(value: number, dir: 1 | -1): number {
  const pct = Math.round(value * 100)
  const grid = ZOOM_STEP * 100
  const next = dir > 0 ? Math.floor(pct / grid) * grid + grid : Math.ceil(pct / grid) * grid - grid
  return clamp(next, ZOOM_MIN * 100, ZOOM_MAX * 100) / 100
}

export function ZoomControl({
  value,
  onChange
}: {
  value: number
  onChange: (next: number) => void
}) {
  const pct = Math.round(value * 100)
  return (
    <Popover
      width={220}
      align="right"
      trigger={({ toggle, open }) => (
        <Tooltip label="Zoom" side="bottom">
          <button
            type="button"
            onClick={toggle}
            aria-label="Zoom"
            aria-expanded={open}
            className={`inline-flex h-8 min-w-13 items-center justify-center gap-1 rounded-md px-2 text-xs font-medium tabular-nums hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              open ? 'bg-accent text-foreground' : 'text-muted-foreground'
            }`}
          >
            <ZoomIn className="size-3.5" aria-hidden />
            {pct}%
          </button>
        </Tooltip>
      )}
    >
      {(close) => (
        <ZoomBody
          value={value}
          onChange={onChange}
          onReset={() => {
            onChange(1)
            close()
          }}
        />
      )}
    </Popover>
  )
}

function ZoomBody({
  value,
  onChange,
  onReset
}: {
  value: number
  onChange: (v: number) => void
  onReset: () => void
}) {
  const pct = Math.round(value * 100)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between px-0.5 text-xs">
        <span className="text-muted-foreground">Board zoom</span>
        <code className="rounded bg-muted px-1.5 py-0.5 tabular-nums">
          {pct}%
        </code>
      </div>
      <input
        type="range"
        min={0}
        max={SLIDER_MAX}
        step={1}
        value={zoomToSlider(value)}
        onChange={(e) => {
          // Pointer drags. The detent catches 100% here only: the
          // keyboard steps a whole 5%, which always clears it.
          const raw = sliderToZoom(Number(e.target.value))
          const snapped =
            Math.abs(raw - 1) <= SNAP_RADIUS ? 1 : raw
          onChange(snapped)
        }}
        onKeyDown={(e) => {
          // One track unit is a fraction of a percent, so the native
          // arrow-key step would crawl (and stick in the 100% detent).
          // Step the zoom itself instead.
          const next =
            e.key === 'ArrowRight' || e.key === 'ArrowUp'
              ? keyStep(value, 1)
              : e.key === 'ArrowLeft' || e.key === 'ArrowDown'
                ? keyStep(value, -1)
                : e.key === 'Home'
                  ? ZOOM_MIN
                  : e.key === 'End'
                    ? ZOOM_MAX
                    : null
          if (next === null) return
          e.preventDefault()
          onChange(next)
        }}
        aria-label="Board zoom"
        aria-valuetext={`${pct}%`}
        className="w-full cursor-pointer accent-primary"
      />
      <div className="flex items-center justify-between px-0.5 text-[10px] text-muted-foreground/70">
        <span>{Math.round(ZOOM_MIN * 100)}%</span>
        <span>100%</span>
        <span>{Math.round(ZOOM_MAX * 100)}%</span>
      </div>
      <button
        type="button"
        onClick={onReset}
        disabled={value === 1}
        className="mt-1 rounded border border-border bg-background px-2 py-1 text-xs text-foreground hover:border-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        Reset to 100%
      </button>
    </div>
  )
}
