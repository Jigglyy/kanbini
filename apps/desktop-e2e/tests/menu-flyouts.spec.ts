import { expect, test, type Locator, type Page } from '@playwright/test'
import { launchKanbini, type E2EHandle } from './_launch.js'

// The card and list right-click menus keep their many-option settings in
// fly-outs: a row shows the current value, and hovering (or clicking) it
// opens a second panel beside the menu. Pinned here in the real app:
// hover opens it beside the menu, the labels fly-out stays open while you
// tick several, it flips left near the window's right edge, the keyboard
// works, and Archive takes a card off the board.

let handle: E2EHandle

test.beforeEach(async () => {
  handle = await launchKanbini()
  await handle.page.getByText('Welcome Board', { exact: true }).click()
  await expect(handle.page.getByRole('heading', { name: /^To Do\b/ })).toBeVisible()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

const CARD = 'Drag a card to another list'
const cardEl = (page: Page, title: string): Locator =>
  page.locator('[data-card-id]').filter({ has: page.getByText(title, { exact: true }) })
const menu = (page: Page): Locator => page.locator('[data-overlay="context-menu"]')
const row = (page: Page, label: string): Locator =>
  menu(page).getByRole('button', { name: new RegExp(`^${label}`) })
const flyout = (page: Page, label: string): Locator =>
  page.getByRole('menu', { name: label })

test('a row shows its value and hovering it opens the fly-out beside the menu', async () => {
  const { page } = handle
  await cardEl(page, CARD).click({ button: 'right' })
  await expect(row(page, 'Priority')).toContainText('None')
  // The options aren't in the menu itself any more.
  await expect(menu(page).getByRole('button', { name: 'Urgent' })).toHaveCount(0)

  await row(page, 'Priority').hover()
  await expect(flyout(page, 'Priority')).toBeVisible()
  const m = (await menu(page).boundingBox())!
  const f = (await flyout(page, 'Priority').boundingBox())!
  expect(f.x).toBeGreaterThanOrEqual(m.x + m.width - 2)

  await flyout(page, 'Priority').getByRole('button', { name: 'High' }).click()
  await expect(menu(page)).toHaveCount(0)
  await expect(cardEl(page, CARD).getByText('High', { exact: true })).toBeVisible()
})

test('the labels fly-out stays open while you tick several', async () => {
  const { page } = handle
  // A seeded card with no labels yet (CARD already has Feature).
  await cardEl(page, 'Click the checkbox to complete me').click({ button: 'right' })
  await row(page, 'Labels').click()
  const labels = flyout(page, 'Labels')
  await labels.getByRole('button', { name: /^Bug/ }).click()
  await labels.getByRole('button', { name: /^Feature/ }).click()
  await expect(labels).toBeVisible()
  await expect(row(page, 'Labels')).toContainText(/Feature, Bug|Bug, Feature/)
})

test('near the right edge the fly-out opens to the left of the menu', async () => {
  const { page } = handle
  // A right-click a few px from the window's right edge: the menu is
  // clamped against it, so there's no room for the fly-out on the right.
  await cardEl(page, CARD).evaluate((el) => {
    el.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: window.innerWidth - 4,
        clientY: 200
      })
    )
  })
  await row(page, 'Due date').click()
  const m = (await menu(page).boundingBox())!
  const f = (await flyout(page, 'Due date').boundingBox())!
  expect(f.x + f.width).toBeLessThanOrEqual(m.x + 2)
  const width = await page.evaluate(() => window.innerWidth)
  expect(f.x).toBeGreaterThanOrEqual(0)
  expect(m.x + m.width).toBeLessThanOrEqual(width)
})

test('keyboard: Right opens a fly-out, Escape backs out to the menu', async () => {
  const { page } = handle
  await cardEl(page, CARD).click({ button: 'right' })
  await row(page, 'Priority').focus()
  await page.keyboard.press('ArrowRight')
  await expect(flyout(page, 'Priority')).toBeVisible()
  await expect(flyout(page, 'Priority').getByRole('button').first()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(flyout(page, 'Priority')).toHaveCount(0)
  await expect(menu(page)).toBeVisible()
  await expect(row(page, 'Priority')).toBeFocused()
})

test('Archive card takes it off the board', async () => {
  const { page } = handle
  await cardEl(page, CARD).click({ button: 'right' })
  await menu(page).getByRole('button', { name: 'Archive card' }).click()
  await expect(cardEl(page, CARD)).toHaveCount(0)
})

test('the list menu: Sort cards shows its mode and sets it from the fly-out', async () => {
  const { page } = handle
  await page.getByRole('button', { name: 'Edit list' }).first().click()
  await expect(row(page, 'Sort cards')).toContainText('Manual')
  await row(page, 'Sort cards').click()
  await flyout(page, 'Sort cards').getByRole('button', { name: 'A to Z', exact: true }).click()
  await page.getByRole('button', { name: 'Edit list' }).first().click()
  await expect(row(page, 'Sort cards')).toContainText('A to Z')
})
