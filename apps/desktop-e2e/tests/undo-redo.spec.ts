import { expect, test } from '@playwright/test'
import { launchKanbini, type E2EHandle } from './_launch.js'

// E2E for the server-side undo/redo log (ADR-0036). Every mutation
// routed through applyMutationRecorded is undoable + redoable;
// `edit.undo` (Ctrl+Z) and `edit.redo` (Ctrl+Y) dispatch through
// App.tsx's shortcut handler. Per-board scope means Ctrl+Z from a
// board view only touches that board's entries - exactly the
// scenario this spec drives.

let handle: E2EHandle

test.beforeEach(async () => {
  handle = await launchKanbini()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

test('Ctrl+Z undoes a card create + Ctrl+Y redoes it', async () => {
  const { page } = handle

  // Open the seeded Welcome Board.
  await page.getByText('Welcome Board', { exact: true }).click()
  await expect(page.getByRole('heading', { name: /^To Do\b/ })).toBeVisible()

  // Add a card to "To Do" via the inline AddCard input. The seed's
  // first list is "To Do" so the first matching placeholder is
  // attached to it.
  const addCard = page.getByPlaceholder('+ Add a card').first()
  await addCard.click()
  await addCard.fill('Card that will be undone')
  await addCard.press('Enter')

  await expect(
    page.getByText('Card that will be undone', { exact: true })
  ).toBeVisible()

  // The AddCard input keeps focus after Enter so the user can chain
  // multiple cards. The app's shortcut dispatcher skips when focus
  // is in a text input (ADR-0035) - Ctrl+Z would otherwise fire the
  // input's native undo. Blur first.
  await addCard.blur()

  // Ctrl+Z fires edit.undo → applyMutationRecorded inverts the
  // create as a card.delete. broadcastChange invalidates the
  // board query; the card disappears on the next render.
  await page.keyboard.press('Control+z')
  await expect(
    page.getByText('Card that will be undone', { exact: true })
  ).toHaveCount(0)

  // Ctrl+Y fires edit.redo → the create replays with the SAME id
  // (the recorder preserved the minted id on the forward).
  await page.keyboard.press('Control+y')
  await expect(
    page.getByText('Card that will be undone', { exact: true })
  ).toBeVisible()
})

test('undoing a delete restores the card via the snapshot path', async () => {
  const { page } = handle

  await page.getByText('Welcome Board', { exact: true }).click()
  // Right-click a seeded card → Delete card. The seed's first card
  // in "To Do" is "Drag a card to another list".
  await page
    .getByText('Drag a card to another list', { exact: true })
    .click({ button: 'right' })
  await page.getByRole('button', { name: 'Delete card' }).click()
  await expect(
    page.getByText('Drag a card to another list', { exact: true })
  ).toHaveCount(0)

  // Ctrl+Z restores. card.delete captures a full nested snapshot
  // (labels + checklists + items + activities) - the restore arm
  // replays it in one transaction.
  await page.keyboard.press('Control+z')
  await expect(
    page.getByText('Drag a card to another list', { exact: true })
  ).toBeVisible()
})

test('Ctrl+Shift+Z is also bound to edit.redo', async () => {
  const { page } = handle

  await page.getByText('Welcome Board', { exact: true }).click()

  // Make a small mutation we can undo + redo via the alt binding.
  const addCard = page.getByPlaceholder('+ Add a card').first()
  await addCard.click()
  await addCard.fill('Redo via Shift+Z')
  await addCard.press('Enter')
  await expect(
    page.getByText('Redo via Shift+Z', { exact: true })
  ).toBeVisible()

  // Blur out of the AddCard input so app shortcuts win the keystroke.
  await addCard.blur()
  await page.keyboard.press('Control+z')
  await expect(
    page.getByText('Redo via Shift+Z', { exact: true })
  ).toHaveCount(0)

  // Shortcut registry defaults include Ctrl+Y AND Ctrl+Shift+Z for
  // edit.redo - both should work.
  await page.keyboard.press('Control+Shift+z')
  await expect(
    page.getByText('Redo via Shift+Z', { exact: true })
  ).toBeVisible()
})
