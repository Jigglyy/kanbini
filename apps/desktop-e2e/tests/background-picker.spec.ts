import { expect, test, type Page } from '@playwright/test'
import { launchKanbini, type E2EHandle } from './_launch.js'

// E2E for the ADR-0034 board background picker. Three tabs (Color /
// Gradient / Image) inside one modal hosted by either the boards-
// home context menu OR the board-view rename popover. The first two
// tests drive the board-view path (the rename pencil):
//   - Gradient tab: pick a preset → modal closes → apply persists
//   - Color tab: pick an ACCENT swatch → modal closes → apply persists
// The last drives the boards-home right-click menu: a colour set
// through Background… is cleared by the menu's Colour → "None".
// The Image tab needs the file-picker dialog (test-only env var
// `KANBINI_E2E_DIALOG_FILE` + an image fixture) which is not yet
// covered here.

/** The Welcome Board's stored accent + background, read through the
 *  same preload bridge the renderer uses. */
async function welcomeBoardLook(page: Page) {
  return page.evaluate(async () => {
    type Row = { name: string; color: string | null; background: unknown }
    const api = (window as unknown as { kanbini: { listBoards: () => Promise<Row[]> } })
      .kanbini
    const b = (await api.listBoards()).find((x) => x.name === 'Welcome Board')!
    return { color: b.color, background: b.background }
  })
}

let handle: E2EHandle

test.beforeEach(async () => {
  handle = await launchKanbini()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

test('Gradient tab: pick a preset applies + persists on reopen', async () => {
  const { page } = handle

  await page.getByText('Welcome Board', { exact: true }).click()
  await expect(page.getByRole('heading', { name: /^To Do\b/ })).toBeVisible()

  // Open rename popover → Background… → modal opens with 3 tabs.
  await page.getByRole('button', { name: 'Rename board' }).click()
  await page.getByRole('button', { name: /Background/ }).click()
  const modal = page.getByRole('dialog', { name: 'Board background' })
  await expect(modal).toBeVisible()

  // Default tab is Color (current value is null). Switch to Gradient.
  await modal.getByRole('tab', { name: /Gradient/ }).click()
  // Each gradient renders an aria-labelled swatch "Pick Sunset gradient".
  await modal.getByRole('button', { name: /Pick Sunset gradient/ }).click()
  // Picker auto-closes on Gradient pick.
  await expect(modal).not.toBeVisible()

  // Reopen - the Current preview now reads "Gradient · Sunset".
  await page.getByRole('button', { name: 'Rename board' }).click()
  await page.getByRole('button', { name: /Background/ }).click()
  await expect(
    page.getByRole('dialog', { name: 'Board background' })
  ).toBeVisible()
  await expect(page.getByText(/Gradient · Sunset/)).toBeVisible()
})

test('Color tab: pick a preset applies + Clear restores no-background state', async () => {
  const { page } = handle

  await page.getByText('Welcome Board', { exact: true }).click()
  await page.getByRole('button', { name: 'Rename board' }).click()
  await page.getByRole('button', { name: /Background/ }).click()
  const modal = page.getByRole('dialog', { name: 'Board background' })
  await expect(modal).toBeVisible()

  // Pick the first ACCENTS preset (the blue one). The aria-label
  // is "Pick <css color>"; just grab the first one in the preset
  // strip.
  const firstPreset = modal.getByRole('button', { name: /^Pick oklch/ }).first()
  await firstPreset.click()
  // Auto-close on Color pick.
  await expect(modal).not.toBeVisible()

  // Reopen → Current reads "Color · oklch(...)" → click Clear →
  // back to "No background. Uses the board accent."
  await page.getByRole('button', { name: 'Rename board' }).click()
  await page.getByRole('button', { name: /Background/ }).click()
  const modal2 = page.getByRole('dialog', { name: 'Board background' })
  await expect(modal2).toBeVisible()
  await expect(modal2.getByText(/Color · oklch/)).toBeVisible()

  // Clear is conditional on a non-null current value.
  await modal2.getByRole('button', { name: /Clear/ }).click()
  // Clear doesn't auto-close; the Current preview flips.
  await expect(
    modal2.getByText('No background. Uses the board accent.')
  ).toBeVisible()
})

// Regression: "None" under Colour only cleared the accent, so a board
// coloured through Background… stayed coloured and "None" did nothing.
test('boards home: Colour "None" clears a colour set through Background…', async () => {
  const { page } = handle
  const board = page.getByRole('heading', { name: 'Welcome Board', exact: true })
  await expect(board).toBeVisible()
  const menu = page.locator('[data-overlay="context-menu"]')

  await board.click({ button: 'right' })
  await menu.getByRole('button', { name: 'Background…' }).click()
  const modal = page.getByRole('dialog', { name: 'Board background' })
  await modal.getByRole('button', { name: /^Pick oklch/ }).first().click()
  await expect(modal).not.toBeVisible()
  await expect
    .poll(async () => (await welcomeBoardLook(page)).background)
    .toMatchObject({ kind: 'color' })

  await board.click({ button: 'right' })
  await menu.getByRole('button', { name: 'None' }).click()
  await expect
    .poll(() => welcomeBoardLook(page))
    .toEqual({ color: null, background: null })
})
