import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchKanbini, type E2EHandle } from './_launch.js'
import { mutate, waitForDiscovery, type Discovery } from './_channel.js'
import { isGlowing } from './_glow.js'

// Changes the AI makes over the control channel: the cards it touches
// glow briefly on the open board, and one Ctrl+Z takes back its whole run
// (everything since you last changed something yourself).

let handle: E2EHandle
let d: Discovery
let todo: string
let done: string

const BOARD = 'AI E2E'

test.beforeEach(async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'kanbini-e2e-ai-'))
  handle = await launchKanbini({ userDataDir })
  d = await waitForDiscovery(userDataDir)
  const board = await mutate(d, { type: 'board.create', name: BOARD })
  todo = await mutate(d, { type: 'list.create', boardId: board, name: 'To Do' })
  done = await mutate(d, { type: 'list.create', boardId: board, name: 'Done' })
  await handle.page.getByText(BOARD, { exact: true }).click()
  await expect(handle.page.getByRole('heading', { name: /^To Do\b/ })).toBeVisible()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

const cardEl = (page: Page, title: string): Locator =>
  page.locator('[data-card-id]').filter({ has: page.getByText(title, { exact: true }) })

test('a card the AI changes glows on the open board', async () => {
  const { page } = handle
  const id = await mutate(d, { type: 'card.create', listId: todo, title: 'Draft the plan' })
  await expect(cardEl(page, 'Draft the plan')).toBeVisible()
  await expect.poll(() => isGlowing(cardEl(page, 'Draft the plan'))).toBe(true)
  // And again for an edit to a card that's already there.
  await expect.poll(() => isGlowing(cardEl(page, 'Draft the plan')), { timeout: 5000 }).toBe(false)
  await mutate(d, { type: 'card.update', id, patch: { priority: 'high' } })
  await expect.poll(() => isGlowing(cardEl(page, 'Draft the plan'))).toBe(true)
})

test("a card the user edits doesn't glow", async () => {
  const { page } = handle
  const addCard = page.getByPlaceholder('+ Add a card').first()
  await addCard.click()
  await addCard.fill('Mine')
  await addCard.press('Enter')
  await expect(cardEl(page, 'Mine')).toBeVisible()
  await page.waitForTimeout(400)
  expect(await isGlowing(cardEl(page, 'Mine'))).toBe(false)
})

test("one Ctrl+Z takes back the AI's whole run", async () => {
  const { page } = handle
  const a = await mutate(d, { type: 'card.create', listId: todo, title: 'AI card one' })
  await mutate(d, { type: 'card.create', listId: todo, title: 'AI card two' })
  await mutate(d, { type: 'card.move', id: a, toListId: done })
  await expect(cardEl(page, 'AI card two')).toBeVisible()
  await expect(cardEl(page, 'AI card one')).toBeVisible()

  await page.locator('main').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Control+z')
  await expect(cardEl(page, 'AI card one')).toHaveCount(0)
  await expect(cardEl(page, 'AI card two')).toHaveCount(0)
  // Redo brings the whole run back too.
  await page.keyboard.press('Control+y')
  await expect(cardEl(page, 'AI card one')).toBeVisible()
  await expect(cardEl(page, 'AI card two')).toBeVisible()
})
