// Zoom / pan maths for the media viewer (components/ui/media-viewer.tsx).
// The image is drawn at its natural size, then `translate(x, y)
// scale(scale)` with the origin at its top-left corner, inside a stage
// of `box` size. Pure so the rules are unit-testable.

export interface Size {
  w: number
  h: number
}

export interface View {
  scale: number
  x: number
  y: number
}

/** Most the viewer zooms in: 3200%. */
export const MAX_SCALE = 32
/** One step of the zoom buttons / +/- keys. */
export const ZOOM_STEP = 1.25

/** The scale that fits the whole image in the stage, never past 100%
 *  (a small image shows at its real size, not blown up). */
export function fitScale(nat: Size, box: Size): number {
  if (nat.w <= 0 || nat.h <= 0 || box.w <= 0 || box.h <= 0) return 1
  return Math.min(1, box.w / nat.w, box.h / nat.h)
}

/** How far out the viewer zooms: a quarter of fit. */
export function minScale(nat: Size, box: Size): number {
  return fitScale(nat, box) / 4
}

/** Keep the image where it can be seen: centred on an axis where it's
 *  smaller than the stage, otherwise no gap between its edge and the
 *  stage's. */
export function clampView(view: View, nat: Size, box: Size): View {
  const axis = (pos: number, size: number, room: number): number =>
    size <= room ? (room - size) / 2 : Math.min(0, Math.max(room - size, pos))
  return {
    scale: view.scale,
    x: axis(view.x, nat.w * view.scale, box.w),
    y: axis(view.y, nat.h * view.scale, box.h)
  }
}

/** The view that fits and centres the image. */
export function fittedView(nat: Size, box: Size): View {
  return clampView({ scale: fitScale(nat, box), x: 0, y: 0 }, nat, box)
}

/** Zoom to `scale` (clamped to the limits) keeping the image point under
 *  `at` (stage coordinates) where it is. */
export function zoomTo(view: View, scale: number, at: { x: number; y: number }, nat: Size, box: Size): View {
  const next = Math.min(MAX_SCALE, Math.max(minScale(nat, box), scale))
  const k = next / view.scale
  return clampView(
    { scale: next, x: at.x - (at.x - view.x) * k, y: at.y - (at.y - view.y) * k },
    nat,
    box
  )
}

/** Double-click: from (about) fit, go to 100% - or 200% for an image
 *  that already fits at its real size; from anything else, back to fit. */
export function doubleClickScale(view: View, nat: Size, box: Size): number {
  const fit = fitScale(nat, box)
  const atFit = Math.abs(view.scale - fit) < 0.001
  if (!atFit) return fit
  return fit < 1 ? 1 : 2
}
