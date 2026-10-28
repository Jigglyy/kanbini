import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchKanbini, type E2EHandle } from './_launch.js'
import { mutate, waitForDiscovery, type Discovery } from './_channel.js'

// The board's Archived view (pencil menu > Archived...): archived cards
// and closed lists, each with Restore and Delete. Before this there was
// no way in the app to find either again.

let handle: E2EHandle
let d: Discovery
let ids: { board: string; todo: string; old: string; parked: string }

const BOARD = 'Archive E2E'

test.beforeEach(async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'kanbini-e2e-archived-'))
  handle = await launchKanbini({ userDataDir })
  d = await waitForDiscovery(userDataDir)
  const board = await mutate(d, { type: 'board.create', name: BOARD })
  const todo = await mutate(d, { type: 'list.create', boardId: board, name: 'To Do' })
  const old = await mutate(d, { type: 'list.create', boardId: board, name: 'Old ideas' })
  await mutate(d, { type: 'card.create', listId: todo, title: 'Fix login' })
  const parked = await mutate(d, { type: 'card.create', listId: old, title: 'Parked idea' })
  // A closed list, with one of its cards archived too.
  await mutate(d, { type: 'card.update', id: parked, patch: { archived: true } })
  await mutate(d, { type: 'list.update', id: old, patch: { closed: true } })
  ids = { board, todo, old, parked }
  await handle.page.getByText(BOARD, { exact: true }).click()
  await expect(handle.page.getByText('Fix login', { exact: true })).toBeVisible()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

const cardEl = (page: Page, title: string): Locator =>
  page.locator('[data-card-id]').filter({ has: page.getByText(title, { exact: true }) })

async function openArchived(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Rename board' }).click()
  await page.getByRole('button', { name: /^Archived/ }).click()
  const dialog = page.getByRole('dialog', { name: `Archived on ${BOARD}` })
  await expect(dialog).toBeVisible()
  return dialog
}

test('a card archived from its menu shows up under Archived and can be restored', async () => {
  const { page } = handle
  await cardEl(page, 'Fix login').click({ button: 'right' })
  await page.getByRole('button', { name: 'Archive card' }).click()
  await expect(cardEl(page, 'Fix login')).toHaveCount(0)

  const dialog = await openArchived(page)
  const row = dialog.getByRole('listitem', { name: 'Fix login' })
  await expect(row).toContainText('in To Do')
  await row.getByRole('button', { name: 'Restore' }).click()
  await expect(row).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(cardEl(page, 'Fix login')).toBeVisible()
})

test('restoring a card in a closed list brings the list back with it', async () => {
  const { page } = handle
  await expect(page.getByRole('heading', { name: /^Old ideas\b/ })).toHaveCount(0)
  const dialog = await openArchived(page)
  const row = dialog.getByRole('listitem', { name: 'Parked idea' })
  await expect(row).toContainText('Old ideas (archived too)')
  await row.getByRole('button', { name: 'Restore' }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: /^Old ideas\b/ })).toBeVisible()
  await expect(cardEl(page, 'Parked idea')).toBeVisible()
})

test('a closed list can be restored, or deleted after a confirm', async () => {
  const { page } = handle
  const dialog = await openArchived(page)
  const list = dialog.getByRole('listitem', { name: 'Old ideas' })
  await list.getByRole('button', { name: 'Delete' }).click()
  await expect(list).toContainText('Delete “Old ideas” and its 0 cards?')
  await list.getByRole('button', { name: 'Cancel' }).click()
  await list.getByRole('button', { name: 'Restore' }).click()
  await expect(list).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: /^Old ideas\b/ })).toBeVisible()
})
