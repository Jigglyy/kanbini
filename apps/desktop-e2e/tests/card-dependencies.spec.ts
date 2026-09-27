import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchKanbini, type E2EHandle } from './_launch.js'
import { mutate, rpc, waitForDiscovery, type Discovery } from './_channel.js'

// E2E for "waiting on" links. The user links a card to one on ANOTHER
// board from the card detail's search, sees the card turn "Blocked" on
// the board, and the badge goes away live when the blocker is completed
// elsewhere (here over the control channel, as an AI would). Clicking
// the linked title jumps to the other board with that card open. Undo
// brings a removed link back.

let handle: E2EHandle
let d: Discovery
let ids: { waiter: string; blocker: string; homeBoard: string }

const BOARD = 'Launch plan'
const OTHER = 'Legal'
const WAITER = 'Publish the release'
const BLOCKER = 'Sign off the licence review'

test.beforeEach(async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'kanbini-e2e-deps-'))
  handle = await launchKanbini({ userDataDir })
  d = await waitForDiscovery(userDataDir)

  const boardId = await mutate(d, { type: 'board.create', name: BOARD })
  const listId = await mutate(d, { type: 'list.create', boardId, name: 'Todo' })
  const waiter = await mutate(d, { type: 'card.create', listId, title: WAITER })
  const homeBoard = await mutate(d, { type: 'board.create', name: OTHER })
  const otherList = await mutate(d, { type: 'list.create', boardId: homeBoard, name: 'Reviews' })
  const blocker = await mutate(d, { type: 'card.create', listId: otherList, title: BLOCKER })
  ids = { waiter, blocker, homeBoard }

  await handle.page.getByText(BOARD, { exact: true }).click()
  await expect(cardEl(handle.page, waiter)).toBeVisible()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

const cardEl = (page: Page, id: string): Locator =>
  page.locator(`[data-card-id="${id}"]`)

async function linkFromDetail(page: Page): Promise<Locator> {
  await cardEl(page, ids.waiter).click()
  const detail = page.getByRole('dialog', { name: WAITER })
  await expect(detail).toBeVisible()
  await detail.getByRole('button', { name: /add a card/i }).click()
  await detail.getByRole('combobox', { name: /search for the card to wait on/i }).fill('licence')
  await detail.getByRole('option', { name: new RegExp(BLOCKER) }).click()
  await expect(
    detail.getByRole('list', { name: /cards this is waiting on/i }).getByText(`${OTHER} · Reviews`)
  ).toBeVisible()
  return detail
}

test('linking from the detail marks the card Blocked until the blocker is done', async () => {
  const { page } = handle
  const detail = await linkFromDetail(page)

  // Stored the right way round.
  const stored = await rpc<{ blockedBy: Array<{ cardId: string }> }>(d, 'card.get', {
    id: ids.waiter
  })
  expect(stored.blockedBy.map((r) => r.cardId)).toEqual([ids.blocker])

  await page.keyboard.press('Escape')
  await expect(detail).not.toBeVisible()
  const card = cardEl(page, ids.waiter)
  await expect(card.getByText('Blocked')).toBeVisible()

  // Done elsewhere -> the badge clears live.
  await mutate(d, { type: 'card.update', id: ids.blocker, patch: { completed: true } })
  await expect(card.getByText('Blocked')).toHaveCount(0)
})

test('Escape closes the search first, then the card', async () => {
  const { page } = handle
  await cardEl(page, ids.waiter).click()
  const detail = page.getByRole('dialog', { name: WAITER })
  await detail.getByRole('button', { name: /add a card/i }).click()
  const search = detail.getByRole('combobox')
  await expect(search).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(search).toHaveCount(0)
  await expect(detail).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(detail).not.toBeVisible()
})

test('the linked title opens that card on its own board', async () => {
  const { page } = handle
  const detail = await linkFromDetail(page)
  await detail.getByRole('button', { name: BLOCKER, exact: true }).click()

  const other = page.getByRole('dialog', { name: BLOCKER })
  await expect(other).toBeVisible()
  await expect(
    other.getByRole('list', { name: /cards waiting on this/i }).getByText(WAITER)
  ).toBeVisible()
})

test('removing a link can be undone', async () => {
  const { page } = handle
  const detail = await linkFromDetail(page)
  await detail
    .getByRole('list', { name: /cards this is waiting on/i })
    .getByRole('listitem')
    .filter({ hasText: BLOCKER })
    .hover()
  await detail.getByRole('button', { name: `Stop waiting on "${BLOCKER}"` }).click()
  await expect(detail.getByText(/not waiting on anything/i)).toBeVisible()

  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+z')
  await expect(cardEl(page, ids.waiter).getByText('Blocked')).toBeVisible()
})
