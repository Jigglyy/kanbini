import { expect, test } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchKanbini, type E2EHandle } from './_launch.js'

// E2E for the Settings → Backup & restore flow (M4-A export +
// M4-B import; ADR-0019 plain-text format). Full round-trip:
//   1. Create a recognisable card on the seeded Welcome Board.
//   2. Export now → assert the summary counts shown in Settings.
//   3. Restore from folder → point the (env-overridden) dir
//      dialog at the export root we just wrote.
//   4. Confirm the recognisable card is still there post-restore.
//
// The Restore step uses KANBINI_E2E_DIALOG_DIR to short-circuit
// the native folder picker - the env var is read by main's
// showOpenDialogE2E helper when the dialog asks for an open-
// directory path.

let handle: E2EHandle

test.afterEach(async () => {
  await handle?.cleanup()
})

test('export then restore round-trip preserves cards', async () => {
  // Pre-create the userData dir so we know its path before launching,
  // and can wire KANBINI_E2E_DIALOG_DIR to <userData>/export.
  const userDataDir = await mkdtemp(join(tmpdir(), 'kanbini-e2e-backup-'))
  const exportDir = join(userDataDir, 'export')

  handle = await launchKanbini({
    userDataDir,
    env: { KANBINI_E2E_DIALOG_DIR: exportDir }
  })
  const { page } = handle

  // Open the seeded Welcome Board + add a card we can recognise
  // through the round-trip.
  await page.getByText('Welcome Board', { exact: true }).click()
  const addCard = page.getByPlaceholder('+ Add a card').first()
  await addCard.click()
  await addCard.fill('Survives the export/import')
  await addCard.press('Enter')
  await expect(
    page.getByText('Survives the export/import', { exact: true })
  ).toBeVisible()

  // Settings → Backup & restore. The gear is in the header.
  await page.getByRole('button', { name: 'Settings' }).click()
  await page
    .getByRole('button', { name: 'Backup & restore' })
    .click()

  // Export now → wait for the summary line. The summary text reads
  // like "N boards · M cards · K attachments → <path>".
  await page.getByRole('button', { name: /export now/i }).click()
  await expect(page.getByText(/\d+ cards · \d+ attachments/)).toBeVisible()

  // Restore from folder → click triggers the (overridden) dir
  // dialog; main returns exportDir; importFromFolder wipes the DB
  // + re-inserts; broadcastChange null re-fetches everything.
  await page
    .getByRole('button', { name: /restore from folder/i })
    .click()
  // Restore summary reads like "Restored N cards · K/M files".
  // Generous timeout - importFromFolder does a transaction + file
  // copies + broadcastChange + the renderer's full refetch. 30 s
  // is plenty even on a cold-cache Windows FS.
  await expect(page.getByText(/restored \d+ cards/i)).toBeVisible({
    timeout: 30_000
  })

  // Back to the boards-home + reopen Welcome Board; the card we
  // created before export is still there. Exact match - `/back/i`
  // (or partial 'Back') would also hit "Backup & restore" in the
  // sidebar.
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await page.getByText('Welcome Board', { exact: true }).click()
  await expect(
    page.getByText('Survives the export/import', { exact: true })
  ).toBeVisible()
})
