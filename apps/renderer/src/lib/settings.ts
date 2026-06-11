import { useCallback, useEffect, useState } from 'react'
import type { ActionId, Binding } from './shortcuts'

// Renderer-side preferences (M4-G+ - first slice of what will become
// M4-F's full settings screen). Persisted to localStorage as one JSON
// blob so adding a new field is a one-liner. These are UI-only
// affordances; domain data lives in SQLite and goes through IPC.
//
// If a future setting needs cross-window sync, swap this layer for
// a tiny IPC-backed store - the public hook surface won't change.

export type StartMode = 'home' | 'lastBoard'

/** App colour theme. `system` follows the OS and updates live. */
export type Theme = 'dark' | 'light' | 'system'

export interface Settings {
  /** M5-B first-run · false until the user dismisses the welcome
   *  modal at least once. Persisted (localStorage rides over
   *  upgrades), so reinstall-on-top-of-userData skips the welcome
   *  but a true fresh install (or wiping userData) shows it again.
   *  The actual modal lives in `components/welcome-modal.tsx`. */
  hasSeenWelcome: boolean
  /** M5-B uninstall opt-in · when true, the Windows NSIS uninstaller
   *  deletes `%APPDATA%\\Kanbini` along with the program files. OFF
   *  by default - the privacy-friendly + data-safe default is "leave
   *  the user's data alone unless they say otherwise." Flipping the
   *  toggle fires `uninstall:setRemoveDataOnUninstall`, which main
   *  writes to the Windows registry under HKCU so the uninstaller
   *  can read it after the app's program folder is already gone.
   *  No-op on Mac / Linux. */
  removeDataOnUninstall: boolean
  /** Which screen the app lands on after launch. Defaults to the
   *  home picker so a multi-board user always sees their full list
   *  first. Set to `lastBoard` to auto-jump into the last-opened
   *  board (single-board flow). */
  startMode: StartMode
  /** Opt-in escape hatch from the offline-only rule (ADR-0023).
   *  When true, "Set cover from URL…" lets the user paste a URL
   *  and main fetches OG metadata + the preview image. OFF by
   *  default - the strict-offline promise stays the user's
   *  choice, never silent. */
  linkPreviews: boolean
  /** When true (and `linkPreviews` is also true), typing/pasting a
   *  URL into a card title silently fetches and sets the cover the
   *  same way "Set cover from URL…" does. Existing URL-titled cards
   *  do NOT retro-fetch when the toggle flips on - the per-board
   *  prime in board.tsx skips them. */
  autoCoverFromUrl: boolean
  /** When true, a list at its card limit refuses new cards (the
   *  add-card box is replaced with a "limit reached" notice). */
  cardLimitBlocksCreate: boolean
  /** When true, a card dragged from another list into a list that is
   *  at its card limit bounces back instead of dropping in. */
  cardLimitBlocksDrag: boolean
  /** When true, a card's checklist items render on the in-list card so
   *  they can be ticked without opening the card detail. */
  showChecklistOnCard: boolean
  /** Trello-style label display. When false (default) the in-list card
   *  collapses its label chips to compact colour bars (no text) so a
   *  card carrying both labels and a priority doesn't read as two
   *  competing colour bands. When true the bars expand to named chips.
   *  Clicking any bar on a card flips this board-wide; the Settings
   *  toggle is the non-click way back. The card detail always shows
   *  names regardless. */
  labelsExpanded: boolean
  /** Colour theme. `system` (default) tracks the OS light/dark mode. */
  theme: Theme
  /** Continuous board zoom (CSS `zoom` applied to the board content
   *  only - chrome stays at 100%). 1 = 100%, range 0.5–2.0. Separate
   *  from the window-wide Ctrl/Cmd +/- which uses Electron's
   *  setZoomLevel; the two compose. */
  boardZoom: number
  /** ADR-0035: user-customizable keyboard shortcuts. Sparse map -
   *  only ids the user has touched live here; everything else falls
   *  back to `DEFAULT_BINDINGS` in `lib/shortcuts.ts` via
   *  `resolveBindings`. An explicit empty array means "user removed
   *  every binding for this action" (don't fall back to defaults). */
  shortcuts: Partial<Record<ActionId, Binding[]>>
  /** ADR-0042 · opt-in Obsidian one-way push. When `enabled` is on
   *  AND `vaultPath` is set, Settings → Obsidian's "Sync now" button
   *  pushes every card as a Markdown note under
   *  `<vaultPath>/<subfolder>/<board>/<title>.md`. Off by default
   *  (touches the filesystem outside userData). Push is manual-only
   *  in v1 - no file watcher, no live sync, vault content is never
   *  read back. */
  obsidian: {
    enabled: boolean
    vaultPath: string | null
    /** Subfolder inside the vault to write under. Keeps the vault
     *  tidy + makes it obvious which notes Kanbini owns. */
    subfolder: string
    /** Last successful push timestamp (epoch ms); null = never. Pure
     *  display - the source of truth is the files on disk. */
    lastPush: number | null
  }
}

const DEFAULTS: Settings = {
  hasSeenWelcome: false,
  removeDataOnUninstall: false,
  startMode: 'home',
  linkPreviews: false,
  autoCoverFromUrl: false,
  cardLimitBlocksCreate: true,
  cardLimitBlocksDrag: true,
  showChecklistOnCard: true,
  labelsExpanded: false,
  theme: 'system',
  boardZoom: 1,
  shortcuts: {},
  obsidian: {
    enabled: false,
    vaultPath: null,
    subfolder: 'Kanbini',
    lastPush: null
  }
}

const STORAGE_KEY = 'kanbini.settings'

function readSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw) as Partial<Settings>
    // Merge against defaults so new fields auto-populate on upgrade.
    // Nested objects (`obsidian`) need their own merge so future fields
    // inside them light up without the user touching their blob.
    return {
      ...DEFAULTS,
      ...parsed,
      obsidian: { ...DEFAULTS.obsidian, ...(parsed.obsidian ?? {}) }
    }
  } catch {
    return DEFAULTS
  }
}

function writeSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    /* full disk / private mode - preferences just won't persist */
  }
}

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** Resolve a theme choice to the concrete mode to paint. */
function resolveTheme(theme: Theme): 'dark' | 'light' {
  if (theme === 'system') {
    return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
  }
  return theme
}

/** Set `<html data-theme>` - index.css keys its palette off it. The
 *  inline script in index.html does this for the very first paint (no
 *  flash); this keeps it in sync on every later change. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = resolveTheme(theme)
}

// Same-document fan-out. The `storage` event only fires in OTHER
// documents - never the one that wrote - so the multiple useSettings()
// instances in one window (App, Board, UrlCoverModal, …) need their own
// broadcast channel. Without it, the consent panel flipping
// `linkPreviews` on inside UrlCoverModal left Board's copy stale until
// a remount, so gating like auto-cover didn't engage that session.
const instances = new Set<(s: Settings) => void>()

function broadcast(next: Settings): void {
  for (const notify of instances) notify(next)
}

/** Read + update the app-wide preferences. Mirrors useState's tuple
 *  return; the second slot accepts a partial patch (only the keys
 *  you want to change). */
export function useSettings(): [
  Settings,
  (patch: Partial<Settings>) => void
] {
  const [settings, setSettings] = useState<Settings>(readSettings)

  useEffect(() => {
    // Join the same-document broadcast set (see above).
    instances.add(setSettings)
    // Pick up changes from other tabs / windows (multi-window Kanbini
    // is not a thing today, but `storage` events are free) - and relay
    // them to every instance in THIS document too.
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== STORAGE_KEY) return
      broadcast(readSettings())
    }
    window.addEventListener('storage', onStorage)
    return () => {
      instances.delete(setSettings)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  // Apply the theme on change, and while it's `system` follow live OS
  // light/dark switches.
  useEffect(() => {
    applyTheme(settings.theme)
    if (settings.theme !== 'system') return
    const mq = window.matchMedia(DARK_QUERY)
    const onChange = (): void => applyTheme('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [settings.theme])

  const update = useCallback((patch: Partial<Settings>): void => {
    // Base the merge on the persisted blob (the shared source of
    // truth) rather than this instance's state, then notify every
    // mounted instance - including this one - so all copies converge
    // on the same object. Known edge: if localStorage is unwritable
    // (private mode / full disk) earlier unpersisted patches are lost
    // on the next update; preferences already couldn't persist in
    // that environment.
    const next = { ...readSettings(), ...patch }
    writeSettings(next)
    broadcast(next)
  }, [])

  return [settings, update]
}
