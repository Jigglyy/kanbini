import * as fsSync from 'node:fs'
import { join } from 'node:path'
import { screen, type BrowserWindow } from 'electron'

// Window bounds persistence. Every launch used to open 1280x832
// centered - the most-noticed desktop-app papercut. State lives at
// <userData>/window-state.json: the NORMAL (unmaximized) bounds plus
// a maximized flag, so un-maximizing after a relaunch restores the
// size the user actually chose. Best-effort on both ends: a missing /
// corrupt file falls back to defaults, a failed write is ignored.
//
// The E2E launcher (KANBINI_E2E_HEADLESS) bypasses this module
// entirely - it parks the window at (-30000, -30000) on purpose and
// persisting that would poison a real launch from the same userData.

const FILE = 'window-state.json'

export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

export const DEFAULT_WINDOW_STATE: WindowState = {
  width: 1280,
  height: 832,
  maximized: false
}

const MIN_WIDTH = 400
const MIN_HEIGHT = 300

function asInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null
}

/** True when the saved rect still lands on a connected display (a
 *  monitor may have been unplugged since the last run). Requires a
 *  modest overlap with some display's work area so the title bar
 *  stays reachable. */
function intersectsAnyDisplay(
  x: number,
  y: number,
  width: number,
  height: number
): boolean {
  return screen.getAllDisplays().some((d) => {
    const wa = d.workArea
    const overlapW =
      Math.min(x + width, wa.x + wa.width) - Math.max(x, wa.x)
    const overlapH =
      Math.min(y + height, wa.y + wa.height) - Math.max(y, wa.y)
    return overlapW >= 100 && overlapH >= 40
  })
}

/** Read + validate the persisted state. Only call after app.whenReady
 *  (the `screen` module needs the app ready). */
export function loadWindowState(userDataDir: string): WindowState {
  let parsed: Partial<WindowState>
  try {
    parsed = JSON.parse(
      fsSync.readFileSync(join(userDataDir, FILE), 'utf8')
    ) as Partial<WindowState>
  } catch {
    return { ...DEFAULT_WINDOW_STATE }
  }
  const width = Math.max(
    MIN_WIDTH,
    asInt(parsed.width) ?? DEFAULT_WINDOW_STATE.width
  )
  const height = Math.max(
    MIN_HEIGHT,
    asInt(parsed.height) ?? DEFAULT_WINDOW_STATE.height
  )
  const state: WindowState = {
    width,
    height,
    maximized: parsed.maximized === true
  }
  const x = asInt(parsed.x)
  const y = asInt(parsed.y)
  if (x !== null && y !== null && intersectsAnyDisplay(x, y, width, height)) {
    state.x = x
    state.y = y
  }
  return state
}

/** Persist on resize / move (debounced - those events fire per frame
 *  during a drag), on maximize state flips, and synchronously on
 *  close so the final position always lands. */
export function attachWindowState(
  win: BrowserWindow,
  userDataDir: string
): void {
  let timer: NodeJS.Timeout | null = null

  const save = (): void => {
    try {
      if (win.isDestroyed()) return
      // getNormalBounds reports the restored-size rect even while
      // maximized, so un-maximizing after a relaunch goes back to
      // the size the user picked rather than the full work area.
      const normal = win.getNormalBounds()
      const state: WindowState = {
        x: normal.x,
        y: normal.y,
        width: normal.width,
        height: normal.height,
        maximized: win.isMaximized()
      }
      fsSync.writeFileSync(
        join(userDataDir, FILE),
        JSON.stringify(state, null, 2),
        'utf8'
      )
    } catch {
      /* best-effort - never let bookkeeping break the window */
    }
  }

  const debounced = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, 500)
  }

  win.on('resize', debounced)
  win.on('move', debounced)
  win.on('maximize', debounced)
  win.on('unmaximize', debounced)
  win.on('close', () => {
    if (timer) clearTimeout(timer)
    save()
  })
}
