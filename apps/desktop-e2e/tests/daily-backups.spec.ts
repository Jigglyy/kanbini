import { expect, test } from '@playwright/test'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchKanbini, type E2EHandle } from './_launch.js'

// Daily backups (Settings > Backup & restore): closing Kanbini keeps a
// copy of everything for the day under <userData>/backups/YYYY-MM-DD, and
// a backup can be restored from the list (after a safety copy of now).

let handle: E2EHandle | undefined

test.afterEach(async () => {
  await handle?.cleanup()
  handle = undefined
})

const pad = (n: number) => String(n).padStart(2, '0')
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Quit the way a user does (runs the before-quit export + backup) and
 *  wait for the process to end. */
async function quit(h: E2EHandle): Promise<void> {
  const exited = new Promise<void>((done) => h.app.process().once('exit', () => done()))
  await h.app.evaluate(({ app }) => app.quit())
  await exited
}

test('closing Kanbini keeps a backup for today, and it can be restored', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'kanbini-e2e-daily-'))
  const first = await launchKanbini({ userDataDir })
  await quit(first)
  const backupsDir = join(userDataDir, 'backups')
  expect(readdirSync(backupsDir)).toEqual([today()])
  expect(existsSync(join(backupsDir, today(), 'kanbini.json'))).toBe(true)

  handle = await launchKanbini({ userDataDir })
  const { page } = handle
  await page.getByText('Welcome Board', { exact: true }).click()
  const addCard = page.getByPlaceholder('+ Add a card').first()
  await addCard.click()
  await addCard.fill('Made after the backup')
  await addCard.press('Enter')
  await expect(page.getByText('Made after the backup', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Backup & restore' }).click()
  const row = page.getByRole('listitem', { name: /^Today, / })
  await expect(row).toHaveCount(1)
  await row.getByRole('button', { name: 'Restore…' }).click()
  await row.getByRole('button', { name: 'Restore', exact: true }).click()
  await expect(page.getByText(/^Restored Today/)).toBeVisible({ timeout: 30_000 })
  // What was there before the restore is kept as a safety copy.
  await expect(page.getByRole('listitem').filter({ hasText: 'Before a restore' })).toHaveCount(1)

  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await page.getByText('Welcome Board', { exact: true }).click()
  await expect(page.getByRole('heading').first()).toBeVisible()
  await expect(page.getByText('Made after the backup', { exact: true })).toHaveCount(0)
})
