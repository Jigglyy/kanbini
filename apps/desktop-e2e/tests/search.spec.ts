import { expect, test } from '@playwright/test'
import { launchKanbini, type E2EHandle } from './_launch.js'

// E2E for the cross-board command palette (M4-D, ADR-0030).
// Welcome Board is pre-seeded on first boot with several cards
// ("Drag a card to another list", "Try the label filter above",
// etc.) so a fresh-userData launch already has searchable content.

let handle: E2EHandle

test.beforeEach(async () => {
  handle = await launchKanbini()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

test('command palette finds a card by substring + navigates to it', async () => {
  const { page } = handle

  // Open the Welcome Board so we're inside a board view (the palette
  // works from anywhere, but landing in a board lets us verify the
  // post-navigate state too).
  await page.getByText('Welcome Board', { exact: true }).click()
  await expect(page.getByRole('heading', { name: /^To Do\b/ })).toBeVisible()

  // Open the command palette via the toolbar Search button (mouse
  // equivalent of Ctrl+F / Ctrl+K). The button is in the header
  // chrome with aria-label "Search" (the Tooltip primitive).
  await page.getByRole('button', { name: 'Search' }).click()

  // Scope to the palette dialog so result clicks don't accidentally
  // hit the same card sitting under the modal on the board grid.
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const input = palette.getByPlaceholder(/search cards or jump/i)
  await expect(input).toBeVisible()

  // Search for "drag" - matches the seeded "Drag a card to another
  // list" card on the Welcome Board.
  await input.fill('drag')
  // Wait for the debounced result row to render inside the palette.
  const result = palette.getByText('Drag a card to another list')
  await expect(result).toBeVisible()

  // Activate the hit - opens the CardDetail modal at that card.
  await result.click()
  await expect(
    page.getByRole('dialog', { name: 'Drag a card to another list' })
  ).toBeVisible()
})

test('re-activating the SAME card from the palette reopens the detail', async () => {
  const { page } = handle

  await page.getByText('Welcome Board', { exact: true }).click()
  await expect(page.getByRole('heading', { name: /^To Do\b/ })).toBeVisible()

  const openViaPalette = async (): Promise<void> => {
    await page.getByRole('button', { name: 'Search' }).click()
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    const input = palette.getByPlaceholder(/search cards or jump/i)
    await expect(input).toBeVisible()
    await input.fill('drag')
    const result = palette.getByText('Drag a card to another list')
    await expect(result).toBeVisible()
    await result.click()
  }

  // First open via the palette.
  await openViaPalette()
  const detail = page.getByRole('dialog', {
    name: 'Drag a card to another list'
  })
  await expect(detail).toBeVisible()

  // Close the card detail.
  await page.keyboard.press('Escape')
  await expect(detail).not.toBeVisible()

  // Re-activate the SAME card. Before the one-shot-route fix this was a
  // silent no-op: route.openCardId never changed, so <Board>'s mirror
  // effect didn't re-fire and the detail stayed closed.
  await openViaPalette()
  await expect(detail).toBeVisible()
})

test('Ctrl+F opens the palette (matches the renderer shortcut)', async () => {
  const { page } = handle

  // Wait for boards-home to be interactive - back-to-back launches
  // can fire the keystroke before keyboard focus settles into the
  // window, and the press lands nowhere.
  await expect(
    page.getByRole('heading', { name: /your boards/i })
  ).toBeVisible()
  // Click the body once to guarantee keyboard focus is in-window.
  await page.locator('body').click()

  // App.tsx wires Ctrl+F (primary) and Ctrl+K (secondary) via the
  // shortcut registry. Either should open the palette regardless of
  // route.
  await page.keyboard.press('Control+f')
  await expect(
    page.getByPlaceholder(/search cards or jump/i)
  ).toBeVisible()
  // Escape closes.
  await page.keyboard.press('Escape')
  await expect(
    page.getByPlaceholder(/search cards or jump/i)
  ).not.toBeVisible()
})

test('palette shows a no-matches hint when nothing matches', async () => {
  const { page } = handle

  await expect(
    page.getByRole('heading', { name: /your boards/i })
  ).toBeVisible()
  await page.locator('body').click()

  await page.keyboard.press('Control+f')
  await page
    .getByPlaceholder(/search cards or jump/i)
    .fill('zzz-no-such-card')
  // Renderer text - "No matches." on a non-empty query that
  // returned zero rows from searchCards.
  await expect(page.getByText('No matches.')).toBeVisible()
})
