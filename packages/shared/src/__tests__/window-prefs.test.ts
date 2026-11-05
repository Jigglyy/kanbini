import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WINDOW_PREFS,
  closeOutcome,
  minimizeHides,
  parseWindowPrefs,
  trayLabel,
  trayRecentBoards,
  wantsTray,
  type WindowPrefs
} from '../window-prefs'

// Close / minimize to the tray: the rules main's tray.ts applies.

const prefs = (over: Partial<WindowPrefs> = {}): WindowPrefs => ({ ...DEFAULT_WINDOW_PREFS, ...over })

describe('parseWindowPrefs', () => {
  it('defaults to asking, and not minimizing to the tray', () => {
    expect(parseWindowPrefs(undefined)).toEqual({ closeAction: 'ask', minimizeToTray: false })
    expect(parseWindowPrefs('junk')).toEqual(DEFAULT_WINDOW_PREFS)
  })

  it('keeps each good field when another one is damaged', () => {
    expect(parseWindowPrefs({ closeAction: 'tray', minimizeToTray: 'yes' })).toEqual({
      closeAction: 'tray',
      minimizeToTray: false
    })
    expect(parseWindowPrefs({ closeAction: 'explode', minimizeToTray: true })).toEqual({
      closeAction: 'ask',
      minimizeToTray: true
    })
  })
})

describe('closeOutcome', () => {
  const win = { quitting: false, platform: 'win32' }

  it('follows the setting', () => {
    expect(closeOutcome(prefs({ closeAction: 'ask' }), win)).toBe('ask')
    expect(closeOutcome(prefs({ closeAction: 'tray' }), win)).toBe('hide')
    expect(closeOutcome(prefs({ closeAction: 'quit' }), win)).toBe('close')
  })

  it('just closes once Kanbini is quitting', () => {
    expect(closeOutcome(prefs({ closeAction: 'tray' }), { ...win, quitting: true })).toBe('close')
    expect(closeOutcome(prefs({ closeAction: 'ask' }), { ...win, quitting: true })).toBe('close')
  })

  it('leaves the Mac close button alone', () => {
    expect(closeOutcome(prefs({ closeAction: 'tray' }), { ...win, platform: 'darwin' })).toBe('close')
    expect(minimizeHides(prefs({ minimizeToTray: true }), 'darwin')).toBe(false)
    expect(minimizeHides(prefs({ minimizeToTray: true }), 'linux')).toBe(true)
  })
})

describe('wantsTray', () => {
  it('shows no tray icon with the defaults', () => {
    expect(wantsTray(DEFAULT_WINDOW_PREFS, { hidden: false, platform: 'win32' })).toBe(false)
  })

  it('shows one while hidden, or when a setting can hide the window', () => {
    expect(wantsTray(DEFAULT_WINDOW_PREFS, { hidden: true, platform: 'win32' })).toBe(true)
    expect(wantsTray(prefs({ closeAction: 'tray' }), { hidden: false, platform: 'win32' })).toBe(true)
    expect(wantsTray(prefs({ minimizeToTray: true }), { hidden: false, platform: 'win32' })).toBe(true)
    expect(wantsTray(prefs({ closeAction: 'quit' }), { hidden: false, platform: 'win32' })).toBe(false)
    expect(wantsTray(prefs({ closeAction: 'tray' }), { hidden: true, platform: 'darwin' })).toBe(false)
  })
})

describe('trayRecentBoards', () => {
  const boards = [
    { id: 'a', name: 'Alpha', archived: false },
    { id: 'b', name: 'Beta', archived: true },
    { id: 'c', name: 'Gamma', archived: false },
    { id: 'd', name: 'Delta', archived: false }
  ]

  it('lists recent boards in order, skipping archived and deleted ones', () => {
    expect(trayRecentBoards(['c', 'gone', 'b', 'a', 'c'], boards)).toEqual([
      { id: 'c', name: 'Gamma' },
      { id: 'a', name: 'Alpha' }
    ])
  })

  it('stops at the limit', () => {
    expect(trayRecentBoards(['a', 'c', 'd'], boards, 2).map((b) => b.id)).toEqual(['a', 'c'])
  })
})

describe('trayLabel', () => {
  it('shortens long names and keeps & visible in a Windows menu', () => {
    expect(trayLabel('R&D')).toBe('R&&D')
    expect(trayLabel('A'.repeat(60), 10)).toBe(`${'A'.repeat(9)}…`)
    expect(trayLabel('  Two\n lines ')).toBe('Two lines')
  })
})
