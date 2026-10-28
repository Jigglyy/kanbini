import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchKanbini, type E2EHandle } from './_launch.js'
import { mutate, waitForDiscovery } from './_channel.js'
import { isGlowing } from './_glow.js'

// "Show on board": picking a card in Ctrl+F (or the card detail's
// "in List · Board" line) points the card out instead of opening it -
// scrolled into the middle of the view, glowing for a moment, with
// keyboard focus (Enter opens it) but no selection ring. A card a filter
// hides gets a notice that offers to clear that filter.

let handle: E2EHandle

const BOARD = 'Show E2E'
const OTHER_BOARD = 'Elsewhere'
const TOTAL = 40

test.beforeEach(async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'kanbini-e2e-show-'))
  handle = await launchKanbini({ userDataDir })
  await handle.page.setViewportSize({ width: 1100, height: 700 })
  const d = await waitForDiscovery(userDataDir)
  const boardId = await mutate(d, { type: 'board.create', name: BOARD })
  const longId = await mutate(d, { type: 'list.create', boardId, name: 'Long' })
  const tagsId = await mutate(d, { type: 'list.create', boardId, name: 'Tags' })
  for (let i = 1; i <= TOTAL; i++) {
    await mutate(d, { type: 'card.create', listId: longId, title: `Card ${i}` })
  }
  const bug = await mutate(d, { type: 'label.create', boardId, name: 'Bug', color: 'red' })
  const tagged = await mutate(d, { type: 'card.create', listId: tagsId, title: 'Tagged card' })
  await mutate(d, { type: 'card.setLabels', id: tagged, labelIds: [bug] })
  const otherId = await mutate(d, { type: 'board.create', name: OTHER_BOARD })
  const otherList = await mutate(d, { type: 'list.create', boardId: otherId, name: 'Inbox' })
  await mutate(d, { type: 'card.create', listId: otherList, title: 'Far away card' })

  await handle.page.getByText(BOARD, { exact: true }).click()
  await expect(handle.page.getByText('Card 1', { exact: true })).toBeVisible()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

const cardEl = (page: Page, title: string): Locator =>
  page.locator('[data-card-id]').filter({ has: page.getByText(title, { exact: true }) })

async function pickInPalette(page: Page, query: string, hit: string): Promise<void> {
  await page.keyboard.press('Control+f')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByPlaceholder(/search cards or jump/i).fill(query)
  await expect(palette.getByText(hit, { exact: true })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(palette).not.toBeVisible()
}

test('Ctrl+F shows a card far down a list without opening it; Enter then opens it', async () => {
  const { page } = handle
  const card = cardEl(page, 'Card 38')
  await expect(card).not.toBeInViewport()

  await pickInPalette(page, 'Card 38', 'Card 38')
  await expect(card).toBeInViewport()
  await expect.poll(() => isGlowing(card)).toBe(true)
  // Pointed out, not opened, and not selected.
  await expect(page.getByRole('dialog', { name: 'Card 38' })).toHaveCount(0)
  await expect(card).not.toHaveClass(/ring-2/)

  // Keyboard focus landed on it: Enter opens that card.
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Card 38' })).toBeVisible()
})

test('the card detail says where the card is, and clicking that shows it', async () => {
  const { page } = handle
  await cardEl(page, 'Card 3').getByText('Card 3', { exact: true }).click()
  const detail = page.getByRole('dialog', { name: 'Card 3' })
  await expect(detail).toBeVisible()

  await detail.getByRole('button', { name: `in Long · ${BOARD}` }).click()
  await expect(detail).not.toBeVisible()
  await expect.poll(() => isGlowing(cardEl(page, 'Card 3'))).toBe(true)
})

test('a card the label filter hides: the notice offers to show it', async () => {
  const { page } = handle
  await page.getByRole('button', { name: /^Bug/ }).first().click()
  await expect(page.getByText('Card 5', { exact: true })).toHaveCount(0)

  await pickInPalette(page, 'Card 5', 'Card 5')
  const notice = page.getByRole('status').filter({ hasText: 'hidden by' })
  await expect(notice).toHaveText(/“Card 5” is hidden by your label filter\./)

  await notice.getByRole('button', { name: 'Show it' }).click()
  await expect(notice).toHaveCount(0)
  const card = cardEl(page, 'Card 5')
  await expect(card).toBeInViewport()
  await expect.poll(() => isGlowing(card)).toBe(true)
  // The filter is off now, so the other cards are back too.
  await expect(page.getByText('Card 6', { exact: true })).toBeVisible()
})

test('typing and hitting Enter at once goes to what you typed, not the previous results', async () => {
  const { page } = handle
  await page.keyboard.press('Control+f')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await expect(palette).toBeVisible()
  // No wait between typing and Enter: before the fix, Enter acted on
  // the empty search's board list and opened a board.
  await page.keyboard.type('Far away')
  await page.keyboard.press('Enter')
  await expect(palette).not.toBeVisible()
  await expect(page.getByRole('heading', { name: /^Inbox\b/ })).toBeVisible()
  await expect.poll(() => isGlowing(cardEl(page, 'Far away card'))).toBe(true)
})

test('a result appearing under a resting mouse does not steal Enter', async () => {
  const { page } = handle
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const input = palette.getByPlaceholder(/search cards or jump/i)
  const search = async (): Promise<void> => {
    await page.keyboard.press('Control+f')
    await input.fill('Card 1')
    // The card results for "Card 1", not the board list an empty query
    // shows (that has a third row too).
    await expect(palette.locator('[data-row="2"]')).toContainText('Card 1')
  }
  await search()
  const third = (await palette.locator('[data-row="2"]').boundingBox())!
  await page.keyboard.press('Escape')
  // Park the mouse where the third result will appear, then don't move it.
  await page.mouse.move(third.x + third.width / 2, third.y + third.height / 2)
  await search()
  const first = palette.locator('[data-row="0"]')
  await expect(first).toHaveAttribute('aria-current', 'true')
  const title = (await first.locator('.font-medium').first().textContent())!.trim()
  await page.keyboard.press('Enter')
  await expect.poll(() => isGlowing(cardEl(page, title))).toBe(true)
})

test("Ctrl+F lists the current board's cards before an exact #N on another board", async () => {
  const { page } = handle
  await page.keyboard.press('Control+f')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  // "1" is Elsewhere's exact #1 ("Far away card"), but this board's
  // title matches ("Card 1", "Card 10", ...) come first.
  await palette.getByPlaceholder(/search cards or jump/i).fill('1')
  await expect(palette.getByText('Far away card', { exact: true })).toBeVisible()
  await expect(palette.locator('[data-row="0"]')).toContainText(BOARD)
  const rows = await palette.locator('[data-row]').allTextContents()
  const farAway = rows.findIndex((t) => t.includes('Far away card'))
  expect(rows.slice(0, farAway).every((t) => t.includes(BOARD))).toBe(true)
})

test('Ctrl+Enter in Ctrl+F opens the card straight away', async () => {
  const { page } = handle
  await page.keyboard.press('Control+f')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByPlaceholder(/search cards or jump/i).fill('Card 38')
  await expect(palette.getByText('Card 38', { exact: true })).toBeVisible()
  await page.keyboard.press('Control+Enter')
  await expect(page.getByRole('dialog', { name: 'Card 38' })).toBeVisible()
})

test('Ctrl+F shows a card on another board', async () => {
  const { page } = handle
  await pickInPalette(page, 'Far away', 'Far away card')
  await expect(page.getByRole('heading', { name: /^Inbox\b/ })).toBeVisible()
  const card = cardEl(page, 'Far away card')
  await expect.poll(() => isGlowing(card)).toBe(true)
  await expect(page.getByRole('dialog', { name: 'Far away card' })).toHaveCount(0)
})
