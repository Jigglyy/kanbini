import { expect, test } from '@playwright/test'
import { launchKanbini, type E2EHandle } from './_launch.js'

// E2E for swimlane mode (ADR-0037 slice 2). Toggling Group by →
// Priority on the board re-paints the layout from one row of lists
// to a swimlane grid: ONE list-header row at the top + N lane rows
// underneath (Urgent / High / Medium / Low / No priority). Same
// content, different shape.

let handle: E2EHandle

test.beforeEach(async () => {
  handle = await launchKanbini()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

test('Group by → Priority shows the five priority lane headers', async () => {
  const { page } = handle

  await page.getByText('Welcome Board', { exact: true }).click()
  await expect(page.getByRole('heading', { name: /^To Do\b/ })).toBeVisible()

  // Flat layout: no lane headers anywhere.
  await expect(page.getByRole('heading', { name: 'Urgent' })).toHaveCount(0)

  // Open the board pencil → BoardSettings popover.
  await page.getByRole('button', { name: 'Rename board' }).click()
  // Group by row has two SwimlaneChips: None (active by default) +
  // Priority. Click Priority.
  await page.getByRole('button', { name: 'Priority', exact: true }).click()

  // Lane headers render as <h3> with the lane label, one per row.
  await expect(page.getByRole('heading', { name: 'Urgent' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'High' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Medium' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Low' })).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'No priority' })
  ).toBeVisible()
})

test("Group by → None reverts to the flat layout", async () => {
  const { page } = handle

  await page.getByText('Welcome Board', { exact: true }).click()
  // Open the popover once; SwimlaneChip clicks don't dismiss it, so
  // both flips happen inside one session.
  await page.getByRole('button', { name: 'Rename board' }).click()
  await page.getByRole('button', { name: 'Priority', exact: true }).click()
  // Confirm the swimlane layout came up.
  await expect(page.getByRole('heading', { name: 'Urgent' })).toBeVisible()
  // Flip back. The popover's swimlane row has one "None" chip
  // (BoardSettings has no other "None" buttons - the colour picker
  // lives in a separate modal).
  await page.getByRole('button', { name: 'None', exact: true }).click()
  // Lane headers are gone; the flat-layout list header is back.
  await expect(page.getByRole('heading', { name: 'Urgent' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: /^To Do\b/ })).toBeVisible()
})
