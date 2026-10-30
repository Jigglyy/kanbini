import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchKanbini, type E2EHandle } from './_launch.js'
import { mutate, waitForDiscovery } from './_channel.js'

// After a drag, the dropped card's hover state (the complete-checkbox
// column opened, the title nudged right) has to close once the pointer
// has left it. It used to stay open: dnd-kit focuses the dropped card,
// and the reveal also opened while the card itself held focus.

let handle: E2EHandle

const BOARD = 'Reveal E2E'

test.beforeEach(async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'kanbini-e2e-reveal-'))
  handle = await launchKanbini({ userDataDir })
  const d = await waitForDiscovery(userDataDir)
  const board = await mutate(d, { type: 'board.create', name: BOARD })
  const todo = await mutate(d, { type: 'list.create', boardId: board, name: 'To Do' })
  for (const t of ['First', 'Second', 'Third']) {
    await mutate(d, { type: 'card.create', listId: todo, title: t })
  }
  await handle.page.getByText(BOARD, { exact: true }).click()
  await expect(handle.page.getByText('Third', { exact: true })).toBeVisible()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

const cardEl = (page: Page, title: string): Locator =>
  page.locator('[data-card-id]').filter({ has: page.getByText(title, { exact: true }) })

/** Width of the card's complete-checkbox column (0 when closed). */
const revealWidth = (card: Locator): Promise<number> =>
  card
    .getByRole('button', { name: 'Mark complete' })
    .evaluate((b) => (b.parentElement as HTMLElement).getBoundingClientRect().width)

test('the dropped card closes its hover reveal once the pointer leaves', async () => {
  const { page } = handle
  const from = (await cardEl(page, 'First').boundingBox())!
  const to = (await cardEl(page, 'Third').boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 10, { steps: 5 })
  await page.mouse.move(to.x + to.width / 2, to.y + to.height - 4, { steps: 20 })
  await page.mouse.up()
  // Leave the card for the empty top-left of the board.
  await page.mouse.move(5, 5, { steps: 5 })
  await expect(page.locator('[data-card-id]').last()).toContainText('First')
  // The drop animation + post-drop hold are well under a second.
  await expect.poll(() => revealWidth(cardEl(page, 'First')), { timeout: 3000 }).toBe(0)
  // Hovering still opens it.
  await cardEl(page, 'First').hover()
  await expect.poll(() => revealWidth(cardEl(page, 'First'))).toBeGreaterThan(0)
})

test('keyboard focus on the checkbox still opens the column', async () => {
  const { page } = handle
  await page.mouse.move(5, 5)
  const card = cardEl(page, 'Second')
  expect(await revealWidth(card)).toBe(0)
  // A key press first, so the focus that follows counts as keyboard focus.
  await page.keyboard.press('Shift')
  await card.getByRole('button', { name: 'Mark complete' }).focus()
  await expect.poll(() => revealWidth(card)).toBeGreaterThan(0)
})
