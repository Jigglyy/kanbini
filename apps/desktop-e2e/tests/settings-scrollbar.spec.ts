import { expect, test, type Page } from '@playwright/test'
import { launchKanbini, type E2EHandle } from './_launch.js'

// Regression: the Settings screen is a centered column inside the app's
// single scroll container (<main>). A short tab (Startup) has no
// scrollbar; a tall one (Shortcuts) does, and the 12px scrollbar used to
// steal width from <main> so the whole column re-centered a few px when
// switching tabs. `scrollbar-gutter: stable` reserves the space up front
// so the layout holds still. Same for the boards home, which uses the
// same centered column.

let handle: E2EHandle | undefined

test.afterEach(async () => {
  await handle?.cleanup()
})

/** Left edge of the "Settings" heading, in viewport px. */
async function settingsLeft(page: Page): Promise<number> {
  const box = await page.getByRole('heading', { name: 'Settings' }).boundingBox()
  if (!box) throw new Error('Settings heading not rendered')
  return box.x
}

/** True when <main> is scrolling (content taller than the viewport). */
async function mainOverflows(page: Page): Promise<boolean> {
  return page.locator('main').evaluate((el) => el.scrollHeight > el.clientHeight)
}

test('settings column does not shift when a tab gains a scrollbar', async () => {
  handle = await launchKanbini()
  const { page } = handle
  await page.getByRole('button', { name: 'Settings' }).click()

  await page.getByRole('button', { name: 'Startup' }).click()
  await expect(page.getByRole('radio', { name: /boards menu/i })).toBeVisible()
  expect(await mainOverflows(page)).toBe(false)
  const shortLeft = await settingsLeft(page)

  await page.getByRole('button', { name: 'Shortcuts' }).click()
  await expect(page.getByText('Focus next card in list')).toBeVisible()
  // The test only means something if this tab really scrolls.
  expect(await mainOverflows(page)).toBe(true)
  const tallLeft = await settingsLeft(page)

  expect(tallLeft).toBe(shortLeft)
})
