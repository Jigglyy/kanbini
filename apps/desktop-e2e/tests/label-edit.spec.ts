import { expect, test } from '@playwright/test'
import { launchKanbini, type E2EHandle } from './_launch.js'

// E2E for right-click editing of an existing label from the header
// LabelBar (rename / recolour / delete via the ContextMenu). The
// backend mutations (label.update / label.delete) already existed; this
// pins the renderer surface that reaches them.

let handle: E2EHandle

test.beforeEach(async () => {
  handle = await launchKanbini()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

test('right-click a label chip to rename, recolour, then delete it', async () => {
  const { page } = handle

  // Into the seeded Welcome Board (the LabelBar lives in the board
  // header chrome).
  await page.getByText('Welcome Board', { exact: true }).click()
  await expect(page.getByRole('heading', { name: /^To Do\b/ })).toBeVisible()

  // Create a label with a unique name so we can target its chip.
  await page.getByRole('button', { name: /new label/i }).click()
  await page.getByPlaceholder('Label name').fill('WIP')
  await page.getByRole('button', { name: /add label/i }).click()
  const chip = page.getByRole('button', { name: 'WIP', exact: true })
  await expect(chip).toBeVisible()

  // Right-click opens the editor in a body-portal ContextMenu.
  await chip.click({ button: 'right' })
  const menu = page.locator('[data-overlay="context-menu"]')
  await expect(menu.getByText('Rename label')).toBeVisible()
  const nameInput = menu.getByPlaceholder('Label name')
  await expect(nameInput).toHaveValue('WIP')

  // Rename via Enter -> the chip text updates live (optimistic).
  await nameInput.fill('Doing')
  await nameInput.press('Enter')
  await expect(
    page.getByRole('button', { name: 'Doing', exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'WIP', exact: true })
  ).toHaveCount(0)

  // Recolour: reopen the editor, pick a swatch, menu stays open.
  await page.getByRole('button', { name: 'Doing', exact: true }).click({
    button: 'right'
  })
  const swatches = menu.getByLabel(/^Colour oklch/)
  await swatches.first().click()
  // The menu is still open after a colour pick (so name + colour can be
  // changed in one pass) - dismiss it.
  await page.keyboard.press('Escape')

  // Filter by the label first (left-click the chip). No seeded card
  // carries it, so the board empties out - a seeded card disappears.
  const seededCard = page.getByText('Drag a card to another list', {
    exact: true
  })
  await expect(seededCard).toBeVisible()
  await page.getByRole('button', { name: 'Doing', exact: true }).click()
  await expect(seededCard).toHaveCount(0)

  // Delete the label WHILE it's the active filter: the chip goes away
  // AND the now-stale filter id is pruned, so the board recovers
  // instead of being stranded empty with no chip left to clear.
  await page.getByRole('button', { name: 'Doing', exact: true }).click({
    button: 'right'
  })
  await menu.getByText('Delete label').click()
  await expect(
    page.getByRole('button', { name: 'Doing', exact: true })
  ).toHaveCount(0)
  await expect(seededCard).toBeVisible()
})
