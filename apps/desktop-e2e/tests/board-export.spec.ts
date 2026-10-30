import { expect, test } from '@playwright/test'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchKanbini, type E2EHandle } from './_launch.js'

// Export a board to a .kanbini file and import it back as a new board,
// both ways: "Lists and all cards" from the boards home's right-click
// menu, "Just the lists" from the board's pencil menu. The save and
// open dialogs are overridden to one temp path (KANBINI_E2E_SAVE_FILE /
// KANBINI_E2E_DIALOG_FILE), so each export is what the next import reads.

let handle: E2EHandle

test.afterEach(async () => {
  await handle?.cleanup()
})

test('a board exported with its cards comes back as a new board', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'kanbini-e2e-boardfile-')), 'welcome.kanbini')
  handle = await launchKanbini({
    env: { KANBINI_E2E_SAVE_FILE: file, KANBINI_E2E_DIALOG_FILE: file }
  })
  const { page } = handle
  const boardHeading = page.getByRole('heading', { name: 'Welcome Board', exact: true })
  await expect(boardHeading).toBeVisible()

  // Lists and all cards (the default), from the right-click menu.
  await boardHeading.click({ button: 'right' })
  await page.getByRole('button', { name: 'Export…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Export board' })
  await expect(dialog.getByRole('radio', { name: /Lists and all cards/ })).toBeChecked()
  await dialog.getByRole('button', { name: 'Export…', exact: true }).click()
  const done = page.getByRole('dialog', { name: 'Board exported' })
  await expect(done.getByRole('heading', { name: 'Exported “Welcome Board”' })).toBeVisible()
  await expect(done.getByText('welcome.kanbini')).toBeVisible()
  expect(existsSync(file)).toBe(true)
  await done.getByRole('button', { name: 'Done' }).click()

  await page.getByRole('button', { name: 'Import board', exact: true }).click()
  await page.getByRole('button', { name: /Kanbini board file/ }).click()

  // The import opens the new board: same lists, same cards, same labels.
  await expect(page.getByRole('heading', { name: /^In Progress\b/ })).toBeVisible({
    timeout: 15_000
  })
  await expect(page.getByText('Try the label filter above', { exact: true })).toBeVisible()
  await expect(page.getByText('Scaffold the stack (M0)', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Bug\b/ }).first()).toBeVisible()

  await page.keyboard.press('Alt+b') // nav.home
  await expect(page.getByRole('heading', { name: 'Welcome Board', exact: true })).toHaveCount(2)
})

test('a board exported as just its lists comes back with no cards', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'kanbini-e2e-boardfile-')), 'lists.kanbini')
  handle = await launchKanbini({
    env: { KANBINI_E2E_SAVE_FILE: file, KANBINI_E2E_DIALOG_FILE: file }
  })
  const { page } = handle
  await page.getByRole('heading', { name: 'Welcome Board', exact: true }).click()
  await expect(page.getByText('Try the label filter above', { exact: true })).toBeVisible()

  // From the board's pencil menu this time.
  await page.getByRole('button', { name: 'Rename board' }).click()
  await page.getByRole('button', { name: 'Export board…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Export board' })
  await dialog.getByRole('radio', { name: /Just the lists/ }).check()
  await dialog.getByRole('button', { name: 'Export…', exact: true }).click()
  const done = page.getByRole('dialog', { name: 'Board exported' })
  await done.getByRole('button', { name: 'Done' }).click()

  await page.keyboard.press('Alt+b') // nav.home
  await page.getByRole('button', { name: 'Import board', exact: true }).click()
  await page.getByRole('button', { name: /Kanbini board file/ }).click()

  await expect(page.getByRole('heading', { name: /^In Progress\b/ })).toBeVisible({
    timeout: 15_000
  })
  await expect(page.getByRole('heading', { name: /^To Do\b/ })).toBeVisible()
  await expect(page.locator('[data-card-id]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Feature\b/ }).first()).toBeVisible()
})
