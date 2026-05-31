import { expect, test } from '@playwright/test'
import { launchKanbini, type E2EHandle } from './_launch.js'

// End-to-end happy path for a brand-new user. Boots a clean Electron
// process against a temp userData directory, then walks the most
// important affordances of the app in order:
//
//   1. Land on the boards-home empty state
//   2. Open "New board" dialog + create the first board
//   3. Create the first list (BoardEmptyState)
//   4. Add cards via the inline AddCard input
//   5. Add a second list + drag-like target verifying state
//   6. Open a card via its title + edit the description (TipTap)
//   7. Set the priority via the right-click CardMenu
//   8. Post a comment via the TipTap composer
//   9. Toggle the card complete (then back to incomplete)
//  10. Delete the card from the right-click menu
//  11. Confirm the card disappears from the list
//
// Every step asserts what a real user would see. The test runs end-
// to-end through real preload + real IPC + real SQLite + real React
// rendering inside Electron's Chromium - no mocks of any kind.

let handle: E2EHandle

test.beforeEach(async () => {
  handle = await launchKanbini()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

test('new user creates a board, list, card, edits it, comments, then deletes', async () => {
  const { page } = handle

  // ── 1. Boards-home ────────────────────────────────────────────
  // Desktop main pre-seeds a Welcome Board on first boot
  // (apps/desktop/src/main/index.ts → seedSampleData), so a brand-
  // new userData lands here on boards-home with one card visible.
  await expect(
    page.getByRole('heading', { name: /your boards/i })
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Welcome Board', exact: true })
  ).toBeVisible()

  // ── 2. New board dialog (header CTA) ──────────────────────────
  // The header's "New board" button is the canonical entry point
  // once at least one board exists.
  await page.getByRole('button', { name: 'New board', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: /^new board$/i })
  ).toBeVisible()
  // Scope to the dialog - `getByLabel('Name')` would also match the
  // Sort-by-name selector behind the modal.
  await page
    .getByRole('dialog', { name: 'New board' })
    .getByRole('textbox', { name: 'Name' })
    .fill('E2E happy path')
  await page.getByRole('button', { name: 'Create board' }).click()

  // ── 3. Board view + BoardEmptyState ───────────────────────────
  // Same modal had "Create board" too - but in the board view's
  // empty state the only button is "Create first list".
  await expect(page.getByText(/this board is empty/i)).toBeVisible()
  await page.getByPlaceholder('List name').fill('To do')
  await page.getByRole('button', { name: /create first list/i }).click()

  // The list appears + the inline "+ Add a list" stub returns. The
  // ListHeader's <h2> contains both the list name and the card-count
  // chip ("0") so `exact: true` would miss - match by regex.
  await expect(
    page.getByRole('heading', { name: /^To do\b/ })
  ).toBeVisible()
  await expect(page.getByPlaceholder('+ Add a list')).toBeVisible()

  // ── 4. Add the first card via the inline AddCard ──────────────
  // "+ Add a card" is the placeholder; type the title + Enter.
  const addCard = page.getByPlaceholder('+ Add a card')
  await addCard.click()
  await addCard.fill('Pick up groceries')
  await addCard.press('Enter')
  // The new card title appears inside the list.
  await expect(
    page.getByText('Pick up groceries', { exact: true })
  ).toBeVisible()

  // ── 5. Add a second list using the inline stub ────────────────
  const addList = page.getByPlaceholder('+ Add a list')
  await addList.click()
  await addList.fill('Doing')
  await addList.press('Enter')
  await expect(page.getByRole('heading', { name: /^Doing\b/ })).toBeVisible()

  // ── 6. Open the card detail + edit the description ────────────
  await page.getByText('Pick up groceries', { exact: true }).click()
  // CardDetail's <Modal> sets aria-label to the card's title, so
  // the dialog role doubles as a "we're on the right card" check.
  const detailModal = page.getByRole('dialog', {
    name: 'Pick up groceries'
  })
  await expect(detailModal).toBeVisible()
  // Title input - no accessible label; pre-filled with the card's
  // name, so attr-value selector is the cleanest grip.
  const titleInput = detailModal.locator('input[value="Pick up groceries"]')
  await expect(titleInput).toBeVisible()

  // MarkdownField's display mode is a <div role="button"> reading
  // "Add a description…" until clicked. Click to enter edit mode.
  await page.getByText('Add a description…').click()
  // The click resolves before React re-renders to mount MarkdownEditor
  // + TipTap focuses its contenteditable. Without explicitly waiting
  // for the editor to be present + focused, keyboard.type races the
  // mount and the first character lands on whatever was focused at
  // click time (the trigger span) - observable as "pples..." in the
  // saved description. Scope to the Description section + click the
  // ProseMirror surface to confirm focus, then type.
  const descriptionSection = detailModal.locator('section', {
    hasText: 'Description'
  })
  const descriptionEditor = descriptionSection.locator(
    '.tiptap[contenteditable="true"]'
  )
  await descriptionEditor.click()
  await page.keyboard.type('Apples, bread, coffee.', { delay: 20 })
  // Click on the modal header area (above the editor) to fire the
  // outside-pointerdown listener that exits edit mode.
  await titleInput.click()
  // The rendered description should now contain the typed line.
  await expect(
    page.getByText('Apples, bread, coffee.', { exact: false })
  ).toBeVisible()

  // ── 7. Set priority via the right-click CardMenu ──────────────
  // Close the detail first - CardMenu lives on the in-list card,
  // not the detail modal.
  await page.getByRole('button', { name: 'Close' }).click()
  await expect(titleInput).not.toBeVisible()

  // Right-click the card title → CardMenu opens (ContextMenu portal).
  await page
    .getByText('Pick up groceries', { exact: true })
    .click({ button: 'right' })
  // PriorityPicker renders the four-level radio strip - click "High".
  await page.getByRole('button', { name: 'High', exact: true }).click()
  // Reopen detail to confirm the priority chip rendered.
  await page.getByText('Pick up groceries', { exact: true }).click()
  await expect(
    page.getByText('High', { exact: true }).first()
  ).toBeVisible()

  // ── 7b. Create a label + assign it via the CardMenu ───────────
  // Close detail so the LabelBar (board-view chrome) is reachable.
  await page.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('button', { name: /new label/i }).click()
  await page.getByPlaceholder('Label name').fill('Errands')
  await page.getByRole('button', { name: /add label/i }).click()
  // Filter chip with the new label name appears in the LabelBar.
  await expect(
    page.getByRole('button', { name: 'Errands', exact: true })
  ).toBeVisible()
  // Right-click the card → toggle the label on via LabelToggleList.
  await page
    .getByText('Pick up groceries', { exact: true })
    .click({ button: 'right' })
  // LabelToggleList renders one button per board label (text +
  // optional ✓). The LabelBar's filter chip also has text "Errands"
  // - disambiguate by excluding the chip's `title` attr that the
  // CardMenu row doesn't have.
  await page
    .locator('button:not([title])', { hasText: /^Errands$/ })
    .click()
  // Dismiss the menu (click anywhere outside).
  await page.keyboard.press('Escape')
  // The card now carries the label. With the Trello-style bars default
  // (settings.labelsExpanded off) the in-list card renders it as a
  // compact colour bar that exposes the name through its accessible
  // label - assert on the card itself (scoped by data-card-id), not the
  // LabelBar filter chip that also reads "Errands".
  const groceriesCard = page.locator('[data-card-id]', {
    hasText: 'Pick up groceries'
  })
  await expect(
    groceriesCard.getByRole('button', { name: /Label Errands/i })
  ).toBeVisible()

  // Reopen detail for the remaining steps - comment + complete +
  // delete all use the detail modal as their host.
  await page.getByText('Pick up groceries', { exact: true }).click()
  await expect(detailModal).toBeVisible()

  // ── 8. Post a comment via the TipTap composer ─────────────────
  // The "Write a comment…" placeholder is a TipTap CSS pseudo-
  // element on a data-placeholder attribute, not a DOM text node -
  // can't `getByText` it. Scope to the Comments section + click
  // the editable surface (contenteditable="true"). The description
  // is in display mode by now (MarkdownView = contenteditable=false)
  // so the only contenteditable in the modal is the comment composer.
  const commentsSection = detailModal.locator('section', {
    hasText: 'Comments'
  })
  const composer = commentsSection.locator('.tiptap[contenteditable="true"]')
  await composer.click()
  // Same TipTap focus-race fix as the description above.
  await page.keyboard.type('Bought everything except coffee.', {
    delay: 20
  })
  await page.getByRole('button', { name: 'Comment', exact: true }).click()
  // The thread renders newest-first; the new comment appears as a
  // MarkdownView with our text inside the Comments section.
  await expect(
    commentsSection.getByText('Bought everything except coffee.')
  ).toBeVisible()
  // "You" badge appears on human-authored comments.
  await expect(commentsSection.getByText('You').first()).toBeVisible()

  // ── 9. Toggle the card complete + back ────────────────────────
  // The card-detail header has a "Mark complete" / "Completed"
  // checkbox label that toggles based on state.
  const completeCheckbox = page.getByRole('checkbox', {
    name: /mark complete/i
  })
  await completeCheckbox.click()
  await expect(
    page.getByRole('checkbox', { name: 'Completed' })
  ).toBeChecked()
  // And back.
  await page.getByRole('checkbox', { name: 'Completed' }).click()
  await expect(
    page.getByRole('checkbox', { name: /mark complete/i })
  ).not.toBeChecked()

  // ── 10. Delete the card via the CardMenu ─────────────────────
  await page.getByRole('button', { name: 'Close' }).click()
  await page
    .getByText('Pick up groceries', { exact: true })
    .click({ button: 'right' })
  await page.getByRole('button', { name: 'Delete card' }).click()

  // ── 11. Card is gone from the list ────────────────────────────
  await expect(
    page.getByText('Pick up groceries', { exact: true })
  ).toHaveCount(0)
})
