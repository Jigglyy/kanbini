import { expect, test } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchKanbini, type E2EHandle } from './_launch.js'
import { mutate, waitForDiscovery, type Discovery } from './_channel.js'

// E2E for the per-board "Hide completed" toggle in the board header: it
// hides completed cards, a card completed while hiding disappears, the
// choice survives a trip home, and another board keeps its own setting.

let handle: E2EHandle
let d: Discovery
let ids: { open: string; done: string }

test.beforeEach(async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'kanbini-e2e-hide-'))
  handle = await launchKanbini({ userDataDir })
  d = await waitForDiscovery(userDataDir)
  const boardId = await mutate(d, { type: 'board.create', name: 'Garden' })
  const listId = await mutate(d, { type: 'list.create', boardId, name: 'To do' })
  const open = await mutate(d, { type: 'card.create', listId, title: 'Plant bulbs' })
  const done = await mutate(d, { type: 'card.create', listId, title: 'Rake leaves' })
  await mutate(d, { type: 'card.update', id: done, patch: { completed: true } })
  ids = { open, done }
  await handle.page.getByText('Garden', { exact: true }).click()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

test('hides completed cards on this board and remembers it', async () => {
  const { page } = handle
  const cardEl = (id: string) => page.locator(`[data-card-id="${id}"]`)
  await expect(cardEl(ids.done)).toBeVisible()

  await page.getByRole('button', { name: /hide completed \(1\)/i }).click()
  await expect(cardEl(ids.done)).toHaveCount(0)
  await expect(cardEl(ids.open)).toBeVisible()

  // Completing another card while hiding makes it disappear too.
  await mutate(d, { type: 'card.update', id: ids.open, patch: { completed: true } })
  await expect(cardEl(ids.open)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /show completed \(2\)/i })).toBeVisible()

  // Home and back: still hidden.
  await page.keyboard.press('Escape')
  await page.getByText('Garden', { exact: true }).click()
  await expect(page.getByRole('button', { name: /show completed/i })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(cardEl(ids.done)).toHaveCount(0)

  // Another board isn't affected.
  await page.keyboard.press('Escape')
  await page.getByText('Welcome Board', { exact: true }).click()
  await expect(page.getByRole('button', { name: /show completed/i })).toHaveCount(0)
})
