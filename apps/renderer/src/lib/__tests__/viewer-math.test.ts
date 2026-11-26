import { describe, expect, it } from 'vitest'
import {
  MAX_SCALE,
  clampView,
  doubleClickScale,
  fitScale,
  fittedView,
  minScale,
  zoomTo
} from '../viewer-math'

// The media viewer's zoom / pan rules: fit never blows a small image up,
// zoom keeps the point under the cursor still, and the image never
// drifts off where it can't be seen.

const box = { w: 800, h: 600 }

describe('viewer maths', () => {
  it('fits a big image and leaves a small one at its real size', () => {
    expect(fitScale({ w: 1600, h: 1200 }, box)).toBe(0.5)
    expect(fitScale({ w: 4000, h: 600 }, box)).toBe(0.2)
    expect(fitScale({ w: 100, h: 100 }, box)).toBe(1)
    expect(fitScale({ w: 0, h: 0 }, box)).toBe(1)
  })

  it('centres the fitted image', () => {
    expect(fittedView({ w: 1600, h: 1200 }, box)).toEqual({ scale: 0.5, x: 0, y: 0 })
    expect(fittedView({ w: 100, h: 50 }, box)).toEqual({ scale: 1, x: 350, y: 275 })
  })

  it('keeps the point under the cursor still when zooming', () => {
    const nat = { w: 1600, h: 1200 }
    const v = zoomTo({ scale: 0.5, x: 0, y: 0 }, 1, { x: 200, y: 150 }, nat, box)
    expect(v.scale).toBe(1)
    // Image point (400, 300) was under the cursor; it still is.
    expect((200 - v.x) / v.scale).toBe(400)
    expect((150 - v.y) / v.scale).toBe(300)
  })

  it('clamps the zoom to its limits', () => {
    const nat = { w: 1600, h: 1200 }
    expect(zoomTo(fittedView(nat, box), 1000, { x: 0, y: 0 }, nat, box).scale).toBe(MAX_SCALE)
    expect(zoomTo(fittedView(nat, box), 0.0001, { x: 0, y: 0 }, nat, box).scale).toBe(
      minScale(nat, box)
    )
  })

  it('never leaves a gap between a big image and the stage edge', () => {
    const nat = { w: 1600, h: 1200 }
    // Panned way past the edges: pulled back.
    expect(clampView({ scale: 1, x: 500, y: -5000 }, nat, box)).toEqual({ scale: 1, x: 0, y: -600 })
  })

  it('double-click goes fit -> 100% -> fit, and 200% for a small image', () => {
    const big = { w: 1600, h: 1200 }
    expect(doubleClickScale(fittedView(big, box), big, box)).toBe(1)
    expect(doubleClickScale({ scale: 1, x: 0, y: 0 }, big, box)).toBe(0.5)
    const small = { w: 100, h: 100 }
    expect(doubleClickScale(fittedView(small, box), small, box)).toBe(2)
  })
})
