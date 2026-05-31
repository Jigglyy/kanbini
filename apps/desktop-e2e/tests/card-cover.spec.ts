import { expect, test } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchKanbini, type E2EHandle } from './_launch.js'

// E2E for the in-detail Cover entry point added 2026-05-26 (M4-H
// follow-up - see TODO under the ADR-0023/ADR-0033 cover surface).
// The right-click `CardMenu` already shipped with Set from file… /
// Set from URL… / Remove cover; this spec drives the SECOND entry
// point that lives inside `<CardDetail>` so the chain
//   CoverActions.click → attachmentAdd IPC (native dialog overridden
//     via KANBINI_E2E_DIALOG_FILE) → card.update(coverAttachmentId)
//     → broadcastChange → CoverImage renders an <img src=
//     "kanbini-file://…">
// gets exercised end-to-end through real preload + IPC + SQLite +
// Chromium. JSDOM-level tests can't validate the kanbini-file://
// scheme handler or the dialog-override path; that's what's
// unique-to-E2E here.

let handle: E2EHandle

test.afterEach(async () => {
  await handle?.cleanup()
})

// 1x1 transparent PNG, bytes-from-spec. Tiny enough to commit into
// the test, and any valid PNG works for the cover render - we only
// need an `<img>` whose src loads without error.
const TRANSPARENT_PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, // IDAT chunk
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, // IEND chunk
  0x42, 0x60, 0x82
])

test('CardDetail → Set from file… picks an image, sets the cover, image renders', async () => {
  // Drop the fixture PNG to a temp file; the (overridden) file dialog
  // will return its absolute path.
  const tmp = await mkdtemp(join(tmpdir(), 'kanbini-e2e-cover-'))
  const fixturePath = join(tmp, 'cover.png')
  await writeFile(fixturePath, TRANSPARENT_PNG_BYTES)

  handle = await launchKanbini({
    env: { KANBINI_E2E_DIALOG_FILE: fixturePath }
  })
  const { page } = handle

  // Open the seeded Welcome Board.
  await page.getByText('Welcome Board', { exact: true }).click()
  await expect(
    page.getByRole('heading', { name: /^To Do\b/ })
  ).toBeVisible()

  // Open a card from the seeded data. "Click the checkbox to complete
  // me" is one of the To Do cards seedSampleData inserts.
  await page
    .getByText('Click the checkbox to complete me', { exact: true })
    .click()

  // The detail modal's aria-label is the card title (CardDetail
  // passes `card.title` as the Modal label).
  const detailModal = page.getByRole('dialog', {
    name: 'Click the checkbox to complete me'
  })
  await expect(detailModal).toBeVisible()

  // CoverActions renders inside the detail. Scope via testid so
  // the per-attachment row's "Remove cover" button on a hovered
  // current-cover row can't collide. Re-evaluated on every use
  // (Playwright locators are lazy) so post-mutation re-renders
  // don't leave us holding a stale handle.
  const coverRow = detailModal.locator('[data-testid="cover-actions"]')
  await expect(coverRow).toBeVisible()

  // No cover yet → Remove cover absent; click Set from file… instead.
  await expect(
    coverRow.getByRole('button', { name: /remove cover/i })
  ).toHaveCount(0)

  // Trigger the file pick. KANBINI_E2E_DIALOG_FILE makes main's
  // showOpenDialogE2E helper return the fixturePath synchronously,
  // so attachmentAdd resolves with the uploaded file's attachment
  // view + main fires card.update(coverAttachmentId) + broadcasts.
  await coverRow
    .getByRole('button', { name: /set from file/i })
    .click()

  // Proof the full IPC chain landed: the "Remove cover" button in
  // CoverActions is React-state-driven and only renders when
  // `card.coverAttachmentId` is non-null. Its appearance means
  // attachmentAdd → card.update → broadcastChange → cache refresh
  // → re-render all completed. 15 s timeout covers back-to-back
  // full-suite system load; the happy path completes in <500 ms.
  await expect(
    coverRow.getByRole('button', { name: /remove cover/i })
  ).toBeVisible({ timeout: 15_000 })

  // At least one <img> with the kanbini-file:// scheme src renders
  // - proves the renderer wired the attachment through. Two end up
  // matching at full state (CoverImage at top + the attachment-
  // row thumbnail), so `.first().toBeAttached()` is the simplest
  // "exists in DOM" assertion that doesn't couple to count or to
  // Chromium's image-decode latency.
  await expect(
    detailModal.locator('img[src^="kanbini-file://"]').first()
  ).toBeAttached()
})
