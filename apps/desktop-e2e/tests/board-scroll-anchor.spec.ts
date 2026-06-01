import { expect, test } from '@playwright/test'
import { launchKanbini, type E2EHandle } from './_launch.js'

// Pins `overflow-anchor: none` on the board scroll container.
// useSmoothHeight manually compensates this container's scrollTop when a
// card above the fold changes height (see card-hover-scroll.spec); native
// scroll anchoring must stay OFF here so the two don't both adjust
// scrollTop and fight. This guards the property; card-hover-scroll.spec
// guards the actual no-jump behaviour.

let handle: E2EHandle

test.beforeEach(async () => {
  handle = await launchKanbini()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

test('the board scroll container disables scroll anchoring', async () => {
  const { page } = handle

  await page.getByText('Welcome Board', { exact: true }).click()
  await expect(page.getByRole('heading', { name: /^To Do\b/ })).toBeVisible()

  const main = page.locator('main')
  await expect(main).toHaveCount(1)
  const overflowAnchor = await main.evaluate(
    (el) => getComputedStyle(el).overflowAnchor
  )
  expect(overflowAnchor).toBe('none')
})
