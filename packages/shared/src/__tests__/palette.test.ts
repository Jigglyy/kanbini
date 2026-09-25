import { describe, expect, it } from 'vitest'
import {
  ACCENT_NAMES,
  ACCENT_PALETTE,
  ACCENT_VALUES,
  accentNameOf,
  resolveAccentColor
} from '../palette'

// The named accent palette moved here from the renderer so the MCP
// server can turn "red" into the exact swatch string. Stored rows keep
// whatever string they were saved with, so a value changing is a
// visible product change - these tests make it a deliberate one.

describe('ACCENT_PALETTE', () => {
  it('holds exactly the swatches the renderer shipped with, in order', () => {
    // Snapshot of apps/renderer/src/lib/palette.ts ACCENTS as it stood
    // before the move. Re-tuning a colour means editing this list too.
    expect(ACCENT_VALUES).toEqual([
      'oklch(0.63 0.19 25)',
      'oklch(0.72 0.19 48)',
      'oklch(0.76 0.14 85)',
      'oklch(0.84 0.15 105)',
      'oklch(0.74 0.17 140)',
      'oklch(0.64 0.15 160)',
      'oklch(0.68 0.10 195)',
      'oklch(0.74 0.12 210)',
      'oklch(0.69 0.13 230)',
      'oklch(0.60 0.16 262)',
      'oklch(0.56 0.17 292)',
      'oklch(0.62 0.18 322)',
      'oklch(0.67 0.20 352)',
      'oklch(0.66 0.19 8)'
    ])
  })

  it('has unique names and unique values', () => {
    expect(new Set(ACCENT_NAMES).size).toBe(ACCENT_PALETTE.length)
    expect(new Set(ACCENT_VALUES).size).toBe(ACCENT_PALETTE.length)
  })

  it('names and values line up index-for-index', () => {
    ACCENT_PALETTE.forEach((s, i) => {
      expect(ACCENT_NAMES[i]).toBe(s.name)
      expect(ACCENT_VALUES[i]).toBe(s.value)
    })
  })

  it('every value fits the mutation colour cap (32 chars)', () => {
    for (const v of ACCENT_VALUES) expect(v.length).toBeLessThanOrEqual(32)
  })
})

describe('resolveAccentColor', () => {
  it('maps a palette name to its swatch value', () => {
    expect(resolveAccentColor('blue')).toBe('oklch(0.60 0.16 262)')
  })

  it('is case- and whitespace-insensitive for names', () => {
    expect(resolveAccentColor('  Red ')).toBe('oklch(0.63 0.19 25)')
  })

  it('passes a raw CSS colour through, trimmed', () => {
    expect(resolveAccentColor(' #ff0000 ')).toBe('#ff0000')
    expect(resolveAccentColor('oklch(0.5 0.1 100)')).toBe('oklch(0.5 0.1 100)')
  })

  it('round-trips with accentNameOf for every swatch', () => {
    for (const name of ACCENT_NAMES) {
      expect(accentNameOf(resolveAccentColor(name))).toBe(name)
    }
  })
})

describe('accentNameOf', () => {
  it('returns null for off-palette and empty values', () => {
    expect(accentNameOf('#123456')).toBeNull()
    expect(accentNameOf(null)).toBeNull()
    expect(accentNameOf(undefined)).toBeNull()
  })
})
