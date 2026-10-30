import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchKanbini, type E2EHandle } from './_launch.js'
import { mutate, waitForDiscovery, type Discovery } from './_channel.js'

// Card menu "Duplicate" / "Move..." / "Copy...": a copy right below the
// card, and a move onto another board that keeps the card's labels by name
// (creating the one the other board lacks) and comes back with one Ctrl+Z.

let handle: E2EHandle
let d: Discovery

const HOME = 'Transfer Home'
const WORK = 'Transfer Work'

test.beforeEach(async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'kanbini-e2e-transfer-'))
  handle = await launchKanbini({ userDataDir })
  d = await waitForDiscovery(userDataDir)
  const home = await mutate(d, { type: 'board.create', name: HOME })
  const work = await mutate(d, { type: 'board.create', name: WORK })
  const todo = await mutate(d, { type: 'list.create', boardId: home, name: 'To Do' })
  await mutate(d, { type: 'list.create', boardId: work, name: 'Inbox' })
  const urgent = await mutate(d, { type: 'label.create', boardId: home, name: 'Urgent', color: 'red' })
  await mutate(d, { type: 'label.create', boardId: work, name: 'Urgent', color: 'blue' })
  const idea = await mutate(d, { type: 'label.create', boardId: home, name: 'Idea', color: 'green' })
  const rent = await mutate(d, { type: 'card.create', listId: todo, title: 'Pay rent' })
  await mutate(d, { type: 'card.setLabels', id: rent, labelIds: [urgent, idea] })
  await mutate(d, { type: 'card.create', listId: todo, title: 'Call mum' })
  await handle.page.getByText(HOME, { exact: true }).click()
  await expect(handle.page.getByText('Pay rent', { exact: true })).toBeVisible()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

const cardEl = (page: Page, title: string): Locator =>
  page.locator('[data-card-id]').filter({ has: page.getByText(title, { exact: true }) })

test('Duplicate puts a copy right below the card', async () => {
  const { page } = handle
  await cardEl(page, 'Pay rent').click({ button: 'right' })
  await page.getByRole('button', { name: 'Duplicate' }).click()
  await expect(cardEl(page, 'Pay rent')).toHaveCount(2)
  const cards = page.locator('[data-card-id]')
  await expect(cards.nth(0)).toContainText('Pay rent')
  await expect(cards.nth(1)).toContainText('Pay rent')
  await expect(cards.nth(2)).toContainText('Call mum')
})

test('Move to another board keeps the labels by name, and one Ctrl+Z brings it back', async () => {
  const { page } = handle
  await cardEl(page, 'Pay rent').click({ button: 'right' })
  await page.getByRole('button', { name: 'Move…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Move card' })
  await dialog.getByRole('combobox', { name: 'Board' }).selectOption({ label: WORK })
  await expect(dialog.getByRole('combobox', { name: 'List' })).toHaveValue(/.+/)
  await dialog.getByRole('button', { name: 'Move', exact: true }).click()
  await expect(dialog.getByRole('heading', { name: `Moved to ${WORK}` })).toBeVisible()
  await expect(cardEl(page, 'Pay rent')).toHaveCount(0)

  await dialog.getByRole('button', { name: 'Open card' }).click()
  // On the other board, with its labels: Work's own "Urgent" plus a new
  // "Idea" created there.
  const detail = page.getByRole('dialog', { name: 'Pay rent' })
  await expect(detail).toBeVisible()
  await expect(detail.getByText('Urgent', { exact: true }).first()).toBeVisible()
  await expect(detail.getByText('Idea', { exact: true }).first()).toBeVisible()
  await expect(detail).toContainText(/moved to\s*Inbox\s*on\s*Transfer Work/)
  await page.keyboard.press('Escape')

  // Undo happens from the board it was moved FROM.
  await page.keyboard.press('Alt+b') // nav.home
  await page.getByText(HOME, { exact: true }).click()
  await expect(cardEl(page, 'Call mum')).toBeVisible()
  await page.keyboard.press('Control+z')
  await expect(cardEl(page, 'Pay rent')).toBeVisible()
  await expect(page.locator('[data-card-id]').first()).toContainText('Pay rent')
})
