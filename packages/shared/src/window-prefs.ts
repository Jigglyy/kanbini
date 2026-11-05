import { z } from 'zod'

// Closing / minimizing Kanbini to the system tray (ADR-0084). Main owns
// these preferences: it handles the window's close and minimize events
// itself, before the renderer is involved, so they live in
// `<userData>/window-prefs.json` (not the renderer's localStorage
// settings), and Settings > Window reads and writes them over IPC. The
// rules are pure functions here so they're unit-tested; main's tray.ts
// just applies them.

export const zCloseAction = z.enum(['ask', 'tray', 'quit'])
export type CloseAction = z.infer<typeof zCloseAction>

export const zWindowPrefs = z.object({
  /** What the window's close button does. 'ask' = ask the next time
   *  and remember the answer (it becomes 'tray' or 'quit'). */
  closeAction: zCloseAction,
  /** The minimize button hides Kanbini to the tray, not the taskbar. */
  minimizeToTray: z.boolean()
})
export type WindowPrefs = z.infer<typeof zWindowPrefs>

export const zWindowPrefsPatch = zWindowPrefs.partial()
export type WindowPrefsPatch = z.infer<typeof zWindowPrefsPatch>

export const DEFAULT_WINDOW_PREFS: WindowPrefs = {
  closeAction: 'ask',
  minimizeToTray: false
}

/** A stored prefs blob, each field falling back to its default on its
 *  own: a missing or damaged file must never stop the app or reset the
 *  fields that are fine. */
export function parseWindowPrefs(raw: unknown): WindowPrefs {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const close = zCloseAction.safeParse(o['closeAction'])
  return {
    closeAction: close.success ? close.data : DEFAULT_WINDOW_PREFS.closeAction,
    minimizeToTray:
      typeof o['minimizeToTray'] === 'boolean'
        ? o['minimizeToTray']
        : DEFAULT_WINDOW_PREFS.minimizeToTray
  }
}

/** Whether this platform gets the tray at all. On a Mac, closing the
 *  window already leaves Kanbini running in the Dock, so the close
 *  button keeps its usual behaviour there and there's no tray icon. */
export const traySupported = (platform: string): boolean => platform !== 'darwin'

export type CloseOutcome = 'close' | 'hide' | 'ask'

/** What a click on the window's close button does. `quitting` = Kanbini
 *  is already on its way out (Quit from the tray menu, the OS logging
 *  off), so the window just closes. */
export function closeOutcome(
  prefs: WindowPrefs,
  opts: { quitting: boolean; platform: string }
): CloseOutcome {
  if (opts.quitting || !traySupported(opts.platform)) return 'close'
  if (prefs.closeAction === 'tray') return 'hide'
  if (prefs.closeAction === 'ask') return 'ask'
  return 'close'
}

/** Whether the minimize button should hide the window to the tray. */
export const minimizeHides = (prefs: WindowPrefs, platform: string): boolean =>
  prefs.minimizeToTray && traySupported(platform)

/** Whether the tray icon shows: while the window is hidden in the tray,
 *  and whenever a setting can send it there. With the defaults it
 *  doesn't show, so Kanbini looks the way it always has until the user
 *  picks the tray. */
export function wantsTray(
  prefs: WindowPrefs,
  opts: { hidden: boolean; platform: string }
): boolean {
  if (!traySupported(opts.platform)) return false
  return opts.hidden || prefs.closeAction === 'tray' || prefs.minimizeToTray
}

/** How many recent boards the tray menu lists. */
export const TRAY_RECENT_BOARDS = 5

/** The boards the tray menu lists, most recently opened first: the
 *  renderer's recent ids, skipping boards that are gone or archived. */
export function trayRecentBoards(
  recentIds: readonly string[],
  boards: readonly { id: string; name: string; archived: boolean }[],
  limit: number = TRAY_RECENT_BOARDS
): { id: string; name: string }[] {
  const byId = new Map(boards.map((b) => [b.id, b]))
  const out: { id: string; name: string }[] = []
  for (const id of recentIds) {
    const b = byId.get(id)
    if (!b || b.archived || out.some((o) => o.id === id)) continue
    out.push({ id: b.id, name: b.name })
    if (out.length >= limit) break
  }
  return out
}

/** A board name as a menu row: shortened to `max` characters, and with
 *  `&` doubled (a single one marks a keyboard shortcut letter in a
 *  Windows menu, so "R&D" would show as "RD"). */
export function trayLabel(name: string, max = 40): string {
  const flat = name.replace(/\s+/g, ' ').trim()
  const short = flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
  return short.replace(/&/g, '&&')
}

/** `tray:recentBoards` - the renderer's most recently opened boards. */
export const zTrayRecentBoardsRequest = z.object({
  ids: z.array(z.string()).max(50)
})
export type TrayRecentBoardsRequest = z.infer<typeof zTrayRecentBoardsRequest>
