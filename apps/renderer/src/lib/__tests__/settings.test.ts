import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useSettings } from '../settings'

// Hook test for the renderer-only preferences store. Backed by
// localStorage (cleared in `_setup.ts` before each test) so the
// suite starts every test from the documented defaults.

describe('useSettings', () => {
  it('returns the documented defaults on a fresh DB', () => {
    const { result } = renderHook(() => useSettings())
    const [s] = result.current
    expect(s.startMode).toBe('home')
    expect(s.theme).toBe('system')
    expect(s.linkPreviews).toBe(false)
    expect(s.autoCoverFromUrl).toBe(false)
    expect(s.boardZoom).toBe(1)
    expect(s.cardLimitBlocksCreate).toBe(true)
    expect(s.cardLimitBlocksDrag).toBe(true)
    expect(s.showChecklistOnCard).toBe(true)
    expect(s.shortcuts).toEqual({})
    expect(s.obsidian).toEqual({
      enabled: false,
      vaultPath: null,
      subfolder: 'Kanbini',
      lastPush: null
    })
    // M5-B / ADR-0049 - first-run modal shows by default; uninstall
    // opt-in defaults to OFF (privacy-friendly + data-safe).
    expect(s.hasSeenWelcome).toBe(false)
    expect(s.removeDataOnUninstall).toBe(false)
  })

  it('back-fills new fields when loading an older settings blob', () => {
    // Pre-ADR-0049 shape - neither hasSeenWelcome nor
    // removeDataOnUninstall present. Loading should default each
    // without dropping the user's other saved values.
    localStorage.setItem(
      'kanbini.settings',
      JSON.stringify({ theme: 'dark', boardZoom: 1.25 })
    )
    const { result } = renderHook(() => useSettings())
    const [s] = result.current
    expect(s.theme).toBe('dark')
    expect(s.boardZoom).toBe(1.25)
    expect(s.hasSeenWelcome).toBe(false)
    expect(s.removeDataOnUninstall).toBe(false)
  })

  it('persists hasSeenWelcome + removeDataOnUninstall through update()', () => {
    const { result } = renderHook(() => useSettings())
    act(() => {
      result.current[1]({
        hasSeenWelcome: true,
        removeDataOnUninstall: true
      })
    })
    const [s] = result.current
    expect(s.hasSeenWelcome).toBe(true)
    expect(s.removeDataOnUninstall).toBe(true)

    // Re-mount picks up the persisted blob.
    const { result: r2 } = renderHook(() => useSettings())
    expect(r2.current[0].hasSeenWelcome).toBe(true)
    expect(r2.current[0].removeDataOnUninstall).toBe(true)
  })

  it('persists partial patches without touching unrelated fields', () => {
    const { result } = renderHook(() => useSettings())
    act(() => {
      const [, update] = result.current
      update({ theme: 'dark', boardZoom: 1.25 })
    })
    const [s] = result.current
    expect(s.theme).toBe('dark')
    expect(s.boardZoom).toBe(1.25)
    // Untouched fields still match the defaults.
    expect(s.startMode).toBe('home')
    expect(s.linkPreviews).toBe(false)

    // Re-mounting picks up the persisted blob from localStorage.
    const { result: r2 } = renderHook(() => useSettings())
    expect(r2.current[0].theme).toBe('dark')
    expect(r2.current[0].boardZoom).toBe(1.25)
  })

  it('deep-merges the nested obsidian blob so new fields back-fill defaults', () => {
    // Plant an OLDER settings blob that's missing the obsidian
    // `subfolder` + `lastPush` fields (matches the pre-ADR-0042
    // shape). On read, the hook should fill them in from DEFAULTS
    // without dropping the user's saved vaultPath.
    localStorage.setItem(
      'kanbini.settings',
      JSON.stringify({
        theme: 'light',
        obsidian: { enabled: true, vaultPath: '/path/to/vault' }
      })
    )
    const { result } = renderHook(() => useSettings())
    const [s] = result.current
    expect(s.theme).toBe('light')
    expect(s.obsidian).toEqual({
      enabled: true,
      vaultPath: '/path/to/vault',
      subfolder: 'Kanbini', // defaulted
      lastPush: null // defaulted
    })
  })

  it('applies `data-theme` to <html> on mount', () => {
    renderHook(() => useSettings())
    // matchMedia stub in _setup.ts reports `matches: false`, so the
    // system theme resolves to light.
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('updates `data-theme` when the user picks an explicit theme', () => {
    const { result } = renderHook(() => useSettings())
    act(() => {
      result.current[1]({ theme: 'dark' })
    })
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('falls back to defaults when localStorage holds malformed JSON', () => {
    localStorage.setItem('kanbini.settings', '{not json')
    const { result } = renderHook(() => useSettings())
    expect(result.current[0].theme).toBe('system')
    expect(result.current[0].obsidian.subfolder).toBe('Kanbini')
  })

})
