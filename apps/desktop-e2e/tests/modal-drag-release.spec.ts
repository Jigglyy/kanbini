import { expect, test } from '@playwright/test'
import { launchKanbini, type E2EHandle } from './_launch.js'

// E2E: dragging a text selection out of the card title and releasing over
// the backdrop must not close the card detail; a plain backdrop click must.

let handle: E2EHandle

test.beforeEach(async () => {
  handle = await launchKanbini()
})
test.afterEach(async () => {
  await handle?.cleanup()
})

test('releasing a title drag over the backdrop keeps the card open', async () => {
  const { page } = handle
  await page.getByText('Welcome Board', { exact: true }).click()
  await page
    .locator('[data-card-id]', { hasText: 'Drag a card to another list' })
    .click()
  const modal = page.getByRole('dialog', {
    name: 'Drag a card to another list'
  })
  await expect(modal).toBeVisible()

  const title = modal.locator('input').first()
  const box = (await title.boundingBox())!
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + 10, y)
  await page.mouse.down()
  // x=3 is the backdrop's left gutter, outside the panel.
  await page.mouse.move(3, y, { steps: 8 })
  await page.mouse.up()
  await expect(modal).toBeVisible()

  await page.mouse.click(3, y)
  await expect(modal).toBeHidden()
})
