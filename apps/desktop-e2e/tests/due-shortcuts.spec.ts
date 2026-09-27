import { expect, test } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchKanbini, type E2EHandle } from './_launch.js'
import { mutate, rpc, waitForDiscovery, type Discovery } from './_channel.js'

// E2E for the due-date shortcuts in the card's right-click menu, and the
// chip wording they produce: "Tomorrow" on the card, stored as local
// midnight, and a card due today reads "Today" without the overdue red.

let handle: E2EHandle
let d: Discovery
let cardId: string

test.beforeEach(async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'kanbini-e2e-due-'))
  handle = await launchKanbini({ userDataDir })
  d = await waitForDiscovery(userDataDir)
  const boardId = await mutate(d, { type: 'board.create', name: 'Errands' })
  const listId = await mutate(d, { type: 'list.create', boardId, name: 'To do' })
  cardId = await mutate(d, { type: 'card.create', listId, title: 'Post the parcel' })
  await handle.page.getByText('Errands', { exact: true }).click()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

test('the Tomorrow shortcut sets local midnight and the chip says Tomorrow', async () => {
  const { page } = handle
  const card = page.locator(`[data-card-id="${cardId}"]`)
  await card.click({ button: 'right' })
  await page
    .getByRole('group', { name: 'Due date shortcuts' })
    .getByRole('button', { name: 'Tomorrow' })
    .click()

  await expect(card.getByText('Tomorrow')).toBeVisible()
  const stored = await rpc<{ dueAt: number }>(d, 'card.get', { id: cardId })
  const n = new Date()
  expect(stored.dueAt).toBe(new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1).getTime())
})

test('a card due today is not shown as overdue', async () => {
  const { page } = handle
  const n = new Date()
  await mutate(d, {
    type: 'card.update',
    id: cardId,
    patch: { dueAt: new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime() }
  })
  const chip = page.locator(`[data-card-id="${cardId}"]`).getByText('Today')
  await expect(chip).toBeVisible()
  await expect(chip).not.toHaveClass(/text-danger/)
})
