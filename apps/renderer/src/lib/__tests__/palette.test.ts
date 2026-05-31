import { describe, expect, it } from 'vitest'
import {
  ACCENTS,
  GRADIENT_PRESETS,
  accentText,
  backgroundCss,
  gradientCss,
  swatchOptions,
  tint
} from '../palette'
import { PRIORITY_LEVELS, priorityColor } from '../../components/priority'

// Pure-helper coverage for the renderer's colour layer. The
// palette is small but it's the seam between the DB's stored
// values and what hits CSS - every board card, list header, and
// background passes through here. Regression-prone on a copy /
// paste typo.

describe('accentText', () => {
  it('returns dark text for light accents (L ≥ 0.66)', () => {
    expect(accentText('oklch(0.70 0.13 85)')).toBe('oklch(0.20 0 0)')
    expect(accentText('oklch(0.66 0 0)')).toBe('oklch(0.20 0 0)')
  })

  it('returns white for darker accents', () => {
    expect(accentText('oklch(0.62 0.15 250)')).toBe('#ffffff')
    expect(accentText('oklch(0.30 0 0)')).toBe('#ffffff')
  })

  it('falls back to white for non-oklch (legacy / unparseable) values', () => {
    // No `oklch(...)` match → L parsed as 0 → returns white.
    expect(accentText('#ff8800')).toBe('#ffffff')
    expect(accentText('rgb(255, 200, 50)')).toBe('#ffffff')
    expect(accentText('')).toBe('#ffffff')
  })

  it('every ACCENT swatch picks a readable text colour', () => {
    for (const c of ACCENTS) {
      const text = accentText(c)
      expect(text === '#ffffff' || text === 'oklch(0.20 0 0)').toBe(true)
    }
  })
})

describe('tint', () => {
  it('builds a color-mix string with the right shape', () => {
    expect(tint('oklch(0.62 0.15 250)', 45, 'var(--color-background)')).toBe(
      'color-mix(in oklab, oklch(0.62 0.15 250) 45%, var(--color-background))'
    )
  })

  it('passes the percentage through verbatim (incl. 0 / 100 edge values)', () => {
    expect(tint('red', 0, 'white')).toContain('red 0%')
    expect(tint('red', 100, 'white')).toContain('red 100%')
  })
})

describe('gradientCss', () => {
  it('resolves every documented preset to its CSS gradient', () => {
    for (const preset of GRADIENT_PRESETS) {
      expect(gradientCss(preset.key)).toBe(preset.css)
    }
  })

  it('returns null for an unknown key (no migration on rename)', () => {
    // Forward-compat: a stored key the current build doesn't recognise
    // (older preset removed, future preset added in a later build).
    expect(gradientCss('nope')).toBeNull()
    expect(gradientCss('')).toBeNull()
  })
})

describe('backgroundCss', () => {
  it('returns nulls for a null background (today\'s default)', () => {
    expect(backgroundCss(null)).toEqual({ image: null, color: null })
  })

  it('passes a solid colour through as `color`', () => {
    expect(backgroundCss({ kind: 'color', value: '#ff8800' })).toEqual({
      image: null,
      color: '#ff8800'
    })
  })

  it('resolves a gradient preset to its CSS string', () => {
    const out = backgroundCss({ kind: 'gradient', preset: 'sunset' })
    expect(out.color).toBeNull()
    expect(out.image).toBe(GRADIENT_PRESETS.find((g) => g.key === 'sunset')!.css)
  })

  it('returns null image for an unknown gradient preset (caller falls back)', () => {
    expect(
      backgroundCss({ kind: 'gradient', preset: 'never' })
    ).toEqual({ image: null, color: null })
  })

  it('serves an image-kind background via the kanbini-file:// scheme', () => {
    const out = backgroundCss({
      kind: 'image',
      relPath: 'board-backgrounds/abc/cat.png'
    })
    expect(out.color).toBeNull()
    expect(out.image).toBe(
      'url("kanbini-file://board-backgrounds/abc/cat.png")'
    )
  })

  it('encodes spaces + non-ascii in image relPaths per segment', () => {
    // Each path segment gets `encodeURIComponent` so a `/` separator
    // stays a `/` while spaces and unicode survive the URL boundary.
    const out = backgroundCss({
      kind: 'image',
      relPath: 'board-backgrounds/abc/my photo.png'
    })
    expect(out.image).toBe(
      'url("kanbini-file://board-backgrounds/abc/my%20photo.png")'
    )
  })

  it('encodes unicode + special chars in relPath segments', () => {
    const out = backgroundCss({
      kind: 'image',
      relPath: 'board-backgrounds/abc/écrans #1.png'
    })
    // # would otherwise terminate the URL.
    expect(out.image).toContain('%23')
    expect(out.image).toContain('%C3%A9')
  })
})

describe('swatchOptions', () => {
  it('returns the bare ACCENTS when no colour is set', () => {
    expect(swatchOptions(null)).toBe(ACCENTS)
    expect(swatchOptions(undefined)).toBe(ACCENTS)
  })

  it('returns the bare ACCENTS when the current colour is a standard swatch', () => {
    expect(swatchOptions(ACCENTS[0])).toBe(ACCENTS)
    expect(swatchOptions(ACCENTS[ACCENTS.length - 1])).toBe(ACCENTS)
  })

  it('prepends a non-standard (orphaned) colour so the picker can show + select it', () => {
    // A label/board/list saved under an older palette carries a colour
    // that is no longer one of the swatches.
    const orphan = 'oklch(0.62 0.15 250)' // the original pre-retune blue
    const opts = swatchOptions(orphan)
    expect(opts[0]).toBe(orphan)
    expect(opts).toHaveLength(ACCENTS.length + 1)
    // ...and it isn't duplicated among the standard swatches.
    expect(opts.filter((c) => c === orphan)).toHaveLength(1)
  })
})

describe('label vs priority palettes', () => {
  it('share no colour string (labels are the vivid set, priorities a muted ramp)', () => {
    // The whole point of the ADR-0060 follow-up: a label bar and a
    // priority flag must never resolve to the same colour. Pin it so a
    // future palette tweak can't silently reintroduce a collision.
    for (const p of PRIORITY_LEVELS) {
      expect(ACCENTS).not.toContain(priorityColor(p))
    }
  })
})
