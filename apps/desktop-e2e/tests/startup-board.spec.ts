import { expect, test } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchKanbini, type E2EHandle } from './_launch.js'
import { mutate, waitForDiscovery } from './_channel.js'

// E2E for Settings, Startup, "A specific board": pick a board, restart
// the app on the same userData, and it opens straight into that board
// (not the last one used). Settings live in the renderer's localStorage,
// which Chromium keeps under userData, so a relaunch sees them.

let handle: E2EHandle | undefined

test.afterEach(async () => {
  await handle?.cleanup()
})

test('opens the chosen board on the next launch', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'kanbini-e2e-startup-'))
  const first = await launchKanbini({ userDataDir })
  const d = await waitForDiscovery(userDataDir)
  await mutate(d, { type: 'board.create', name: 'Morning routine' })
  await mutate(d, { type: 'board.create', name: 'Side project' })

  const { page } = first
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Startup' }).click()
  await page.getByRole('radio', { name: /a specific board/i }).check()
  const pick = page.getByRole('combobox', { name: /board to open/i })
  await pick.selectOption({ label: 'Morning routine' })

  // Open a DIFFERENT board last, so "last opened" would pick it instead.
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Your boards' })).toBeVisible()
  await page.getByText('Side project', { exact: true }).click()
  await expect(page.getByText('Side project', { exact: true }).first()).toBeVisible()
  await first.app.close()

  handle = await launchKanbini({ userDataDir })
  await expect(
    handle.page.getByRole('button', { name: /hide completed|new label/i }).first()
  ).toBeVisible()
  await expect(handle.page.getByText('Morning routine', { exact: true }).first()).toBeVisible()
  await expect(handle.page.getByRole('heading', { name: 'Your boards' })).toHaveCount(0)
})
