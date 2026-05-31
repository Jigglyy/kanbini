import { describe, expect, it, vi } from 'vitest'
import { loadOpenedMap, recordOpened } from '../last-opened'

// Renderer-only "last opened at" persistence for the boards-home
// "Recently opened" sort. localStorage-only, single-window - the tests
// exercise the round-trip + the documented "any storage issue → empty
// map" forgiveness.

describe('loadOpenedMap', () => {
  it('returns an empty object when nothing is saved', () => {
    expect(loadOpenedMap()).toEqual({})
  })

  it('round-trips a saved map', () => {
    localStorage.setItem(
      'kanbini.lastOpenedAt',
      JSON.stringify({ b1: 1000, b2: 2000 })
    )
    expect(loadOpenedMap()).toEqual({ b1: 1000, b2: 2000 })
  })

  it('returns an empty object for malformed JSON', () => {
    localStorage.setItem('kanbini.lastOpenedAt', '{not json')
    expect(loadOpenedMap()).toEqual({})
  })

  it('returns an empty object when JSON parses to non-object', () => {
    // Defensive: a stored array / string / null should fall back to {}
    // rather than poisoning the rest of the renderer with a non-record.
    localStorage.setItem('kanbini.lastOpenedAt', JSON.stringify(['nope']))
    expect(loadOpenedMap()).toEqual({})
    localStorage.setItem('kanbini.lastOpenedAt', JSON.stringify(null))
    expect(loadOpenedMap()).toEqual({})
  })
})

describe('recordOpened', () => {
  it('stamps a fresh board id with the current time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-25T10:00:00Z'))
    try {
      recordOpened('b1')
      const map = loadOpenedMap()
      expect(map.b1).toBe(Date.parse('2026-05-25T10:00:00Z'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('overwrites a previous stamp for the same board', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      recordOpened('b1')
      vi.setSystemTime(new Date('2026-05-25T00:00:00Z'))
      recordOpened('b1')
      expect(loadOpenedMap().b1).toBe(Date.parse('2026-05-25T00:00:00Z'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves stamps for other boards (per-id, not global)', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      recordOpened('b1')
      vi.setSystemTime(new Date('2026-05-25T00:00:00Z'))
      recordOpened('b2')
      const map = loadOpenedMap()
      expect(map.b1).toBe(Date.parse('2026-01-01T00:00:00Z'))
      expect(map.b2).toBe(Date.parse('2026-05-25T00:00:00Z'))
    } finally {
      vi.useRealTimers()
    }
  })
})
