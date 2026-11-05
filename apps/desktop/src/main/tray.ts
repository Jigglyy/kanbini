import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  app,
  dialog,
  Menu,
  nativeImage,
  Tray,
  type BrowserWindow,
  type MenuItemConstructorOptions
} from 'electron'
import {
  APP_CODENAME,
  closeOutcome,
  minimizeHides,
  parseWindowPrefs,
  trayLabel,
  trayRecentBoards,
  wantsTray,
  type WindowPrefs,
  type WindowPrefsPatch
} from '@kanbini/shared'
import trayIconIco from '../../build/icon.ico?asset'
import trayIconPng from '../../build/icon.png?asset'

// Close / minimize to the system tray (ADR-0084). The rules are in
// @kanbini/shared window-prefs.ts; this applies them to the window and
// owns the tray icon:
//
//   - Close button: per `closeAction`. 'ask' shows a one-time choice
//     (keep running in the tray / quit) and remembers the answer;
//     Settings > Window changes it later. While Kanbini is quitting
//     (tray menu Quit) or Windows is shutting down / signing out, the
//     window simply closes.
//   - Minimize button: hides to the tray when `minimizeToTray` is on.
//   - Tray icon: shows only while the window is hidden or a setting can
//     hide it, so with the defaults nothing changes. Click = open; the
//     menu has Open, the recently opened boards, and Quit.
//
// The preferences live in `<userData>/window-prefs.json` because main
// needs them before the renderer exists.

const PREFS_FILE = 'window-prefs.json'

export interface TrayController {
  prefs(): WindowPrefs
  setPrefs(patch: WindowPrefsPatch): WindowPrefs
  /** The renderer's most recently opened boards, newest first. */
  setRecentBoards(ids: string[]): void
  /** Rebuild the menu (a board was renamed, archived or deleted). */
  refresh(): void
  /** Wire the window's close / minimize / show / hide events. */
  attach(win: BrowserWindow): void
}

export function createTrayController(opts: {
  userDataDir: string
  boards: () => { id: string; name: string; archived: boolean }[]
  window: () => BrowserWindow | null
  isQuitting: () => boolean
  /** Tray menu "open this board": the window is already showing. */
  onOpenBoard: (boardId: string) => void
}): TrayController {
  const prefsPath = join(opts.userDataDir, PREFS_FILE)
  const platform = process.platform
  // E2E stand-ins: native dialogs and the tray can't be driven by
  // Playwright, and a test window must never be brought on screen.
  const e2e = process.env['KANBINI_E2E_HEADLESS'] === '1'
  const e2eChoice = process.env['KANBINI_E2E_CLOSE_CHOICE']

  let prefs: WindowPrefs
  try {
    prefs = parseWindowPrefs(JSON.parse(readFileSync(prefsPath, 'utf8')))
  } catch {
    prefs = parseWindowPrefs(undefined)
  }
  let recentIds: string[] = []
  let tray: Tray | null = null
  let traySize = { width: 0, height: 0 }
  let asking = false
  // Windows is shutting down or signing out: the window must close.
  let sessionEnding = false

  const save = (): void => {
    try {
      writeFileSync(`${prefsPath}.tmp`, JSON.stringify(prefs, null, 2))
      renameSync(`${prefsPath}.tmp`, prefsPath)
    } catch (err) {
      console.error('[tray] saving window prefs failed:', err)
    }
  }

  const hidden = (): boolean => {
    const win = opts.window()
    return !!win && !win.isDestroyed() && !win.isVisible()
  }

  const showWindow = (): void => {
    const win = opts.window()
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    if (e2e) win.showInactive()
    else {
      win.show()
      win.focus()
    }
  }

  const menuTemplate = (): MenuItemConstructorOptions[] => {
    const recent = trayRecentBoards(recentIds, opts.boards())
    return [
      { label: `Open ${APP_CODENAME}`, click: showWindow },
      { type: 'separator' },
      ...(recent.length > 0
        ? ([
            { label: 'Recent boards', enabled: false },
            ...recent.map((b) => ({
              label: trayLabel(b.name),
              click: () => {
                showWindow()
                opts.onOpenBoard(b.id)
              }
            })),
            { type: 'separator' }
          ] satisfies MenuItemConstructorOptions[])
        : []),
      { label: `Quit ${APP_CODENAME}`, click: () => app.quit() }
    ]
  }
  let lastTemplate: MenuItemConstructorOptions[] = []

  const rebuild = (): void => {
    if (!tray) return
    lastTemplate = menuTemplate()
    tray.setContextMenu(Menu.buildFromTemplate(lastTemplate))
  }
  // Every change event lands here (an AI run can fire dozens), so the
  // menu is rebuilt once things go quiet rather than per change.
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  const refresh = (): void => {
    if (!tray) return
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(rebuild, 250)
  }

  const sync = (): void => {
    const want = wantsTray(prefs, { hidden: hidden(), platform })
    if (want && !tray) {
      // Windows: hand the tray the .ico path itself, so it picks the
      // icon's own small size (crisper than scaling the 256 px one).
      const image =
        platform === 'win32'
          ? nativeImage.createFromPath(trayIconIco)
          : nativeImage.createFromPath(trayIconPng).resize({ width: 22, height: 22 })
      traySize = image.getSize()
      tray = new Tray(platform === 'win32' ? trayIconIco : image)
      tray.setToolTip(APP_CODENAME)
      tray.on('click', showWindow)
      rebuild()
    } else if (!want && tray) {
      clearTimeout(refreshTimer)
      tray.destroy()
      tray = null
    }
  }

  const hideToTray = (win: BrowserWindow): void => {
    win.hide()
    sync()
  }

  const setPrefs = (patch: WindowPrefsPatch): WindowPrefs => {
    prefs = parseWindowPrefs({ ...prefs, ...patch })
    save()
    sync()
    return prefs
  }

  /** The one-time "keep running in the tray?" question. */
  const ask = async (win: BrowserWindow): Promise<void> => {
    if (asking) return
    asking = true
    try {
      let choice: number
      if (e2eChoice) {
        choice = e2eChoice === 'tray' ? 0 : e2eChoice === 'quit' ? 1 : 2
      } else {
        const res = await dialog.showMessageBox(win, {
          type: 'question',
          title: APP_CODENAME,
          message: `Keep ${APP_CODENAME} running in the tray?`,
          detail:
            `${APP_CODENAME} can keep running in the system tray when you close the window, ` +
            'so your boards and AI tools stay ready. Click the tray icon to open it again. ' +
            'You can change this later in Settings > Window.',
          buttons: ['Keep running in the tray', `Quit ${APP_CODENAME}`, 'Cancel'],
          defaultId: 0,
          cancelId: 2,
          noLink: true
        })
        choice = res.response
      }
      if (choice === 0) {
        setPrefs({ closeAction: 'tray' })
        hideToTray(win)
      } else if (choice === 1) {
        setPrefs({ closeAction: 'quit' })
        app.quit()
      }
    } finally {
      asking = false
    }
  }

  if (e2e) {
    // Lets the E2E suite read and click the tray menu (Playwright can't
    // reach the OS tray). Test runs only.
    ;(globalThis as Record<string, unknown>)['__kanbiniTray'] = {
      shown: () => tray !== null,
      iconSize: () => traySize,
      items: () => lastTemplate.map((i) => i.label ?? i.type),
      click: (label: string) => {
        const item = lastTemplate.find((i) => i.label === label)
        ;(item?.click as (() => void) | undefined)?.()
      }
    }
  }

  return {
    prefs: () => prefs,
    setPrefs,
    setRecentBoards: (ids) => {
      recentIds = ids
      refresh()
    },
    refresh,
    attach: (win) => {
      win.on('close', (event) => {
        const outcome = closeOutcome(prefs, {
          quitting: opts.isQuitting() || sessionEnding,
          platform
        })
        if (outcome === 'close') return
        event.preventDefault()
        if (outcome === 'hide') hideToTray(win)
        else void ask(win)
      })
      // 'minimize' can't be cancelled: the window minimizes, then hides
      // (leaving the taskbar); showWindow restores it.
      win.on('minimize', () => {
        if (minimizeHides(prefs, platform)) hideToTray(win)
      })
      win.on('query-session-end', () => {
        sessionEnding = true
      })
      win.on('session-end', () => {
        sessionEnding = true
      })
      win.on('show', sync)
      win.on('hide', sync)
      sync()
    }
  }
}
