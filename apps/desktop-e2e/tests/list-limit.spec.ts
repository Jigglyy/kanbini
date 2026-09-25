import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchKanbini, type E2EHandle } from './_launch.js'
import { mutate, rpc, waitForDiscovery, type Discovery } from './_channel.js'

// E2E for "Show first N" (list.visibleCardLimit). The limit only decides
// which cards are mounted; these pin the rules that keep a hidden card
// reachable: reveal on keyboard focus / search / add, drops land where
// you can see them, range select stays on screen, the header count and
// the saved order always cover every card.

let handle: E2EHandle
let d: Discovery
let ids: { boardId: string; longId: string; shortId: string; cards: string[]; onlyId: string }

const BOARD = 'List limit E2E'
const TOTAL = 30

test.beforeEach(async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'kanbini-e2e-limit-'))
  handle = await launchKanbini({ userDataDir })
  await handle.page.setViewportSize({ width: 1100, height: 900 })
  d = await waitForDiscovery(userDataDir)
  const boardId = await mutate(d, { type: 'board.create', name: BOARD })
  const longId = await mutate(d, { type: 'list.create', boardId, name: 'Long' })
  const shortId = await mutate(d, { type: 'list.create', boardId, name: 'Short' })
  const cards: string[] = []
  for (let i = 0; i < TOTAL; i++) {
    cards.push(await mutate(d, { type: 'card.create', listId: longId, title: `Card ${i + 1}` }))
  }
  const onlyId = await mutate(d, { type: 'card.create', listId: shortId, title: 'Only card' })
  // Set the limit over the channel, as the AI would.
  await mutate(d, { type: 'list.update', id: longId, patch: { visibleCardLimit: 10 } })
  ids = { boardId, longId, shortId, cards, onlyId }
  await handle.page.getByText(BOARD, { exact: true }).click()
  await expect(handle.page.getByText('Card 1', { exact: true })).toBeVisible()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

const longCards = (page: Page): Locator =>
  page.locator(`[data-list-body="${ids.longId}"] [data-card-id]`)
const footer = (page: Page): Locator =>
  page.getByRole('button', { name: /^Show \d+ more$|^Show fewer$/ })

async function savedOrder(): Promise<string[]> {
  const view = await rpc<{ lists: Array<{ id: string; cards: Array<{ title: string }> }> }>(
    d,
    'board.getView',
    { boardId: ids.boardId }
  )
  return view.lists.find((l) => l.id === ids.longId)!.cards.map((c) => c.title)
}

test('a limited list shows N cards and a footer; the header counts them all', async () => {
  const { page } = handle
  await expect(longCards(page)).toHaveCount(10)
  await expect(page.getByRole('button', { name: 'Show 20 more' })).toBeVisible()
  await expect(page.getByRole('heading', { name: /^Long\b/ })).toContainText('30')
})

test('Show more reveals every card, Show fewer folds them back', async () => {
  const { page } = handle
  await page.getByRole('button', { name: 'Show 20 more' }).click()
  await expect(longCards(page)).toHaveCount(TOTAL)
  await page.getByRole('button', { name: 'Show fewer' }).click()
  await expect(longCards(page)).toHaveCount(10)
})

test('the reveal is per session: reopening the board shows N again', async () => {
  const { page } = handle
  await page.getByRole('button', { name: 'Show 20 more' }).click()
  await expect(longCards(page)).toHaveCount(TOTAL)
  await page.keyboard.press('Alt+b') // nav.home
  await page.getByText(BOARD, { exact: true }).click()
  await expect(longCards(page)).toHaveCount(10)
})

test('the list menu sets and clears the limit', async () => {
  const { page } = handle
  await page.getByRole('button', { name: 'Edit list' }).first().click()
  await page.getByRole('button', { name: 'Show all cards' }).click()
  await expect(longCards(page)).toHaveCount(TOTAL)
  await expect(footer(page)).toHaveCount(0)
  await page.getByRole('button', { name: 'Edit list' }).first().click()
  await page.getByRole('button', { name: 'Show at most 20 cards' }).click()
  await expect(longCards(page)).toHaveCount(20)
})

test('keyboard focus past the last visible card reveals the list', async () => {
  const { page } = handle
  await page.getByText('Card 10', { exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Card 10' })).not.toBeVisible()
  await page.keyboard.press('j')
  await expect(page.getByText('Card 11', { exact: true })).toBeInViewport()
  await expect(longCards(page)).toHaveCount(TOTAL)
})

test('opening a hidden card from search reveals its list', async () => {
  const { page } = handle
  await expect(page.getByText('Card 25', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Search' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByPlaceholder(/search cards or jump/i).fill('Card 25')
  await palette.getByText('Card 25', { exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Card 25' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator(`[data-card-id="${ids.cards[24]}"]`)).toBeVisible()
})

test('adding a card to a limited list reveals it, so the new card is visible', async () => {
  const { page } = handle
  const add = page.getByPlaceholder('+ Add a card').first()
  await add.click()
  await add.fill('Brand new')
  await add.press('Enter')
  await expect(page.getByText('Brand new', { exact: true })).toBeVisible()
  await expect(longCards(page)).toHaveCount(TOTAL + 1)
})

test('Shift-click range select skips cards hidden between the ends', async () => {
  // Hidden cards only sit BETWEEN two visible ones when a pinned card is
  // separated from the first N - e.g. a card dropped into an A-to-Z list
  // sorts to the end but stays shown. A range across it must select only
  // what's on screen, not the 20 hidden cards in between.
  const { page } = handle
  await mutate(d, { type: 'list.update', id: ids.longId, patch: { sortMode: 'title-asc' } })
  await mutate(d, { type: 'card.create', listId: ids.shortId, title: 'Zzz last' })
  const zzz = page.getByText('Zzz last', { exact: true })
  await expect(zzz).toBeVisible()
  const from = (await zzz.boundingBox())!
  const to = (await longCards(page).nth(4).boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + 12, { steps: 5 })
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 25 })
  await page.waitForTimeout(150)
  await page.mouse.up()
  // Sorted to the true end of the list, yet still on screen.
  await expect.poll(async () => (await savedOrder()).at(-1)).toBe('Zzz last')
  await expect(page.locator(`[data-list-body="${ids.longId}"]`).getByText('Zzz last')).toBeVisible()
  await expect(longCards(page)).toHaveCount(11)

  // Let the drop animation finish (the overlay unmounts) before clicking:
  // a click that lands mid-animation is part of the drop, not a new gesture.
  await expect(page.locator('.group\\/dragoverlay')).toHaveCount(0)
  await longCards(page).first().click({ modifiers: ['Control'] })
  await expect(page.getByText('1 selected')).toBeVisible()
  await page
    .locator(`[data-list-body="${ids.longId}"]`)
    .getByText('Zzz last', { exact: true })
    .click({ modifiers: ['Shift'] })
  // 10 visible + the pinned one - not all 31.
  await expect(page.getByText('11 selected')).toBeVisible()
})

test('a card dropped on the footer lands just below the last visible card and stays shown', async () => {
  const { page } = handle
  const from = (await page.getByText('Only card', { exact: true }).boundingBox())!
  const to = (await page.getByRole('button', { name: 'Show 20 more' }).boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + 12, { steps: 5 })
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 25 })
  await page.waitForTimeout(150)
  await page.mouse.up()

  // Saved right after Card 10 - NOT at the true end behind 20 hidden cards.
  await expect.poll(async () => (await savedOrder()).indexOf('Only card')).toBe(10)
  // It shows (pinned for the session) and no other card was pushed out:
  // the first 10 are all still on screen.
  await expect(page.locator(`[data-card-id="${ids.onlyId}"]`)).toBeVisible()
  await expect(longCards(page)).toHaveCount(11)
  await expect(page.getByText('Card 10', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Show 20 more' })).toBeVisible()
})

test('a limit set by the AI shows up live', async () => {
  const { page } = handle
  await mutate(d, { type: 'list.update', id: ids.longId, patch: { visibleCardLimit: 20 } })
  await expect(longCards(page)).toHaveCount(20)
  await mutate(d, { type: 'list.update', id: ids.longId, patch: { visibleCardLimit: null } })
  await expect(longCards(page)).toHaveCount(TOTAL)
})

test('lifting a limited list shows the same cards and footer in the drag preview', async () => {
  const { page } = handle
  const header = page.getByRole('heading', { name: /^Long\b/ })
  const box = (await header.boundingBox())!
  await page.mouse.move(box.x + 40, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 60, box.y + box.height / 2 + 10, { steps: 5 })
  await page.mouse.move(box.x + 160, box.y + box.height / 2 + 20, { steps: 10 })
  // The body-portaled clone is aria-hidden (the real column stays put).
  const preview = page.locator('section[aria-hidden="true"]')
  await expect(preview).toBeVisible()
  await expect(preview.locator('ul > li')).toHaveCount(10)
  await expect(preview.getByText('Show 20 more')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.mouse.up()
})
