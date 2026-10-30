import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchKanbini, type E2EHandle } from './_launch.js'
import { mutate, rpc, waitForDiscovery, type Discovery } from './_channel.js'

// Swimlanes (Group by Priority): dragging a card into another lane moves
// it AND changes its priority. Both go as one batch, so one Ctrl+Z puts
// the card back in its lane (it used to take two).

let handle: E2EHandle
let d: Discovery
let cardId: string
let boardId: string
let todo: string
let doing: string

const BOARD = 'Lanes E2E'

test.beforeEach(async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'kanbini-e2e-lanes-'))
  handle = await launchKanbini({ userDataDir })
  d = await waitForDiscovery(userDataDir)
  const board = await mutate(d, { type: 'board.create', name: BOARD })
  boardId = board
  todo = await mutate(d, { type: 'list.create', boardId: board, name: 'To Do' })
  doing = await mutate(d, { type: 'list.create', boardId: board, name: 'Doing' })
  cardId = await mutate(d, { type: 'card.create', listId: todo, title: 'Lane hopper', priority: 'high' })
  await mutate(d, { type: 'card.create', listId: doing, title: 'Low one', priority: 'low' })
  await mutate(d, { type: 'board.update', id: board, patch: { swimlaneMode: 'priority' } })
  await handle.page.getByText(BOARD, { exact: true }).click()
  await expect(handle.page.getByRole('heading', { name: 'No priority' })).toBeVisible()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

/** The (list, lane) cell: lists are columns, so `col` 0 = To Do, 1 = Doing. */
const cell = (page: Page, key: string, col: number): Locator =>
  page.locator(`section[data-lane-cell="${key}"]`).nth(col)
const priorityOf = async () =>
  ((await rpc(d, 'card.get', { id: cardId })) as { priority: string | null }).priority
const listOf = async () => {
  const view = (await rpc(d, 'board.getView', { boardId })) as {
    lists: Array<{ id: string; cards: Array<{ id: string }> }>
  }
  return view.lists.find((l) => l.cards.some((c) => c.id === cardId))?.id
}

async function drag(page: Page, from: Locator, to: Locator): Promise<void> {
  const a = (await from.boundingBox())!
  const b = (await to.boundingBox())!
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2 + 12, { steps: 5 })
  await page.mouse.move(b.x + b.width / 2, b.y + b.height - 6, { steps: 25 })
  await page.mouse.up()
}

test('a drag into another lane and list, and one Ctrl+Z undoes both parts', async () => {
  const { page } = handle
  const card = cell(page, 'high', 0).getByText('Lane hopper', { exact: true })
  await drag(page, card, cell(page, 'low', 1).getByText('Low one', { exact: true }))
  await expect(cell(page, 'low', 1).getByText('Lane hopper', { exact: true })).toBeVisible()
  await expect.poll(priorityOf).toBe('low')
  await expect.poll(listOf).toBe(doing)

  await page.locator('main').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Control+z')
  // Both the lane (priority) and the list come back in one step.
  await expect(cell(page, 'high', 0).getByText('Lane hopper', { exact: true })).toBeVisible()
  await expect.poll(priorityOf).toBe('high')
  await expect.poll(listOf).toBe(todo)
})
