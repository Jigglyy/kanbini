import { expect, test, type Page } from '@playwright/test'
import { launchKanbini, type E2EHandle } from './_launch.js'

// Regression for GitHub issue #1: the board context menu's delete
// confirm ran off the bottom of the screen with no way to scroll to it.
// Two ways in, both pinned here:
//
//   1. The menu opens low, gets clamped to the bottom edge, then
//      "Delete board…" swaps in the taller confirm row. The panel only
//      clamped once (at open), so it grew downward past the viewport.
//   2. On a short window the menu is taller than the viewport, so no
//      clamp can fit it. It has to scroll inside itself (and scrolling
//      inside it must not close it like a page scroll does).

let handle: E2EHandle | undefined

test.afterEach(async () => {
  await handle?.cleanup()
})

const menu = (page: Page) => page.locator('[data-overlay="context-menu"]')

/** Shrinks the window and returns the viewport height it settled at.
 *  The OS has the final say (frame size, minimum height), so the spec
 *  works off the real number instead of the requested one. */
async function shrinkWindow(handle: E2EHandle, height: number): Promise<number> {
  const innerHeight = () => handle.page.evaluate(() => window.innerHeight)
  const before = await innerHeight()
  await handle.app.evaluate(({ BrowserWindow }, h) => {
    BrowserWindow.getAllWindows()[0]!.setSize(1280, h)
  }, height)
  await expect.poll(innerHeight).toBeLessThan(before)
  return innerHeight()
}

/** Full content height of the open menu, scrolled or not. */
const menuContentHeight = (page: Page) => menu(page).evaluate((el) => el.scrollHeight)

async function expectBoardDeleted(page: Page): Promise<void> {
  await expect(
    page.getByRole('heading', { name: 'Welcome Board', exact: true })
  ).toHaveCount(0)
}

test('delete confirm stays on screen when the board menu opens near the bottom', async () => {
  handle = await launchKanbini()
  const { page } = handle
  const board = page.getByRole('heading', { name: 'Welcome Board', exact: true })
  await expect(board).toBeVisible()

  // A right-click a few px above the bottom edge, as on a board in the
  // last row of a full grid. The menu only reads the pointer coords.
  // (Playwright's dispatchEvent builds a plain Event for contextmenu,
  // with no clientX/Y, so build the MouseEvent by hand.)
  await board.evaluate((el) => {
    el.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 300,
        clientY: window.innerHeight - 6
      })
    )
  })
  await expect(menu(page)).toBeVisible()

  await menu(page).getByRole('button', { name: 'Delete board…' }).click()
  const confirm = menu(page).getByRole('button', { name: 'Delete', exact: true })
  await expect(confirm).toBeInViewport({ ratio: 1 })
  await confirm.click()
  await expectBoardDeleted(page)
})

test('board menu scrolls inside a window shorter than the menu', async () => {
  handle = await launchKanbini()
  const { page } = handle
  const board = page.getByRole('heading', { name: 'Welcome Board', exact: true })
  await expect(board).toBeVisible()
  const height = await shrinkWindow(handle, 340)
  // The board now sits at the bottom edge. Bring it into view BEFORE
  // the right-click: the scroll event lands a frame later and a page
  // scroll (correctly) closes an open menu.
  await board.scrollIntoViewIfNeeded()
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  )

  await board.click({ button: 'right' })
  await expect(menu(page)).toBeVisible()
  // Only meaningful if the menu really is taller than the window.
  expect(await menuContentHeight(page)).toBeGreaterThan(height)
  // The panel itself fits the window; the rest is reachable by scrolling.
  const box = await menu(page).boundingBox()
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.y + box!.height).toBeLessThanOrEqual(height)

  // Playwright scrolls the panel to reach the row; that scroll must not
  // close the menu.
  await menu(page).getByRole('button', { name: 'Delete board…' }).click()
  // The taller confirm block lands below the panel's fold; it scrolls
  // itself into view so the user doesn't have to hunt for it.
  const confirm = menu(page).getByRole('button', { name: 'Delete', exact: true })
  await expect(confirm).toBeInViewport({ ratio: 1 })
  await confirm.click()
  await expectBoardDeleted(page)
})
