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
export const ZOOM_STEP = 0.05
// Within this radius of 1.0 the slider snaps to exactly 100% - a
// soft detent so the user can always grab "default" without nudging.
const SNAP_RADIUS = 0.04

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
        min={ZOOM_MIN * 100}
        max={ZOOM_MAX * 100}
        step={ZOOM_STEP * 100}
        value={pct}
        onChange={(e) => {
          const raw = Number(e.target.value) / 100
          const snapped =
            Math.abs(raw - 1) <= SNAP_RADIUS ? 1 : raw
          onChange(snapped)
        }}
        aria-label="Board zoom"
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
