import { expect, test, type ElectronApplication } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchKanbini, type E2EHandle } from './_launch.js'

// Close / minimize to the system tray (ADR-0084), through the real
// window events. The one-time "keep running in the tray?" question is a
// native dialog, answered here through KANBINI_E2E_CLOSE_CHOICE; the OS
// tray can't be reached from Playwright, so main exposes its menu as
// `globalThis.__kanbiniTray` in test runs (read and clicked below).

let handle: E2EHandle

test.afterEach(async () => {
  await handle?.cleanup()
})

const closeWindow = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())

const windowVisible = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())

const tray = {
  shown: (app: ElectronApplication) =>
    app.evaluate(() => (globalThis as any).__kanbiniTray.shown() as boolean),
  items: (app: ElectronApplication) =>
    app.evaluate(() => (globalThis as any).__kanbiniTray.items() as string[]),
  click: (app: ElectronApplication, label: string) =>
    app.evaluate((_e, l) => (globalThis as any).__kanbiniTray.click(l), label)
}

const savedPrefs = async (userDataDir: string) =>
  JSON.parse(await readFile(join(userDataDir, 'window-prefs.json'), 'utf8')) as {
    closeAction: string
    minimizeToTray: boolean
  }

test('the first close asks, then Kanbini keeps running in the tray', async () => {
  handle = await launchKanbini({ env: { KANBINI_E2E_CLOSE_CHOICE: 'tray' } })
  const { app, page, userDataDir } = handle
  // Nothing in the tray until it's chosen.
  expect(await tray.shown(app)).toBe(false)

  await closeWindow(app)
  await expect.poll(() => windowVisible(app)).toBe(false)
  expect(await tray.shown(app)).toBe(true)
  expect((await savedPrefs(userDataDir)).closeAction).toBe('tray')

  await tray.click(app, 'Open Kanbini')
  await expect.poll(() => windowVisible(app)).toBe(true)

  // The menu lists recently opened boards and opens one.
  await page.getByRole('heading', { name: 'Welcome Board', exact: true }).click()
  await expect(page.getByRole('heading', { name: /^To Do\b/ })).toBeVisible()
  await page.keyboard.press('Alt+b') // back to the boards list
  await expect.poll(() => tray.items(app)).toEqual([
    'Open Kanbini',
    'separator',
    'Recent boards',
    'Welcome Board',
    'separator',
    'Quit Kanbini'
  ])
  // Closing again doesn't ask: the answer was remembered.
  await closeWindow(app)
  await expect.poll(() => windowVisible(app)).toBe(false)
  await tray.click(app, 'Welcome Board')
  await expect.poll(() => windowVisible(app)).toBe(true)
  await expect(page.getByRole('heading', { name: /^To Do\b/ })).toBeVisible()
})

test('answering Quit closes Kanbini and remembers it', async () => {
  handle = await launchKanbini({ env: { KANBINI_E2E_CLOSE_CHOICE: 'quit' } })
  const { app, userDataDir } = handle
  const exited = new Promise((resolve) => app.process().once('exit', resolve))
  await closeWindow(app).catch(() => {})
  await exited
  expect((await savedPrefs(userDataDir)).closeAction).toBe('quit')
})

test('Cancel leaves the window open and asks again next time', async () => {
  handle = await launchKanbini({ env: { KANBINI_E2E_CLOSE_CHOICE: 'cancel' } })
  const { app, page } = handle
  await closeWindow(app)
  await page.waitForTimeout(300)
  expect(await windowVisible(app)).toBe(true)
  expect(await tray.shown(app)).toBe(false)
})

test('Settings: minimize to the tray, and closing that quits without asking', async () => {
  handle = await launchKanbini()
  const { app, page, userDataDir } = handle
  await page.getByRole('button', { name: /settings/i }).click()
  await page.getByRole('button', { name: 'Window', exact: true }).click()

  await page.getByRole('checkbox', { name: /Minimize to the tray/ }).check()
  await expect.poll(() => tray.shown(app)).toBe(true)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.minimize())
  await expect.poll(() => windowVisible(app)).toBe(false)
  await tray.click(app, 'Open Kanbini')
  await expect.poll(() => windowVisible(app)).toBe(true)
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMinimized())).toBe(false)

  await page.getByRole('radio', { name: /Quit Kanbini/ }).check()
  await expect.poll(async () => (await savedPrefs(userDataDir)).closeAction).toBe('quit')
  const exited = new Promise((resolve) => app.process().once('exit', resolve))
  await closeWindow(app).catch(() => {})
  await exited
})
