import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchKanbini, type E2EHandle } from './_launch.js'
import { mutate, rpc, waitForDiscovery, type Discovery } from './_channel.js'

// E2E for repeating cards: pick "Weekly" in the card's right-click menu,
// complete the card, and the next one appears in the same list, due a
// week after the old due date. One Ctrl+Z takes both back. Also: a card
// dropped into a list that auto-completes cards sends its next one back
// to the list it came from.

let handle: E2EHandle
let d: Discovery
let ids: { boardId: string; todo: string; done: string; card: string }

const BOARD = 'Chores'
const TITLE = 'Water the plants'

const dayStart = (offset = 0): number => {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset).getTime()
}

test.beforeEach(async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'kanbini-e2e-repeat-'))
  handle = await launchKanbini({ userDataDir })
  d = await waitForDiscovery(userDataDir)
  const boardId = await mutate(d, { type: 'board.create', name: BOARD })
  const todo = await mutate(d, { type: 'list.create', boardId, name: 'To do' })
  const done = await mutate(d, { type: 'list.create', boardId, name: 'Done' })
  const card = await mutate(d, { type: 'card.create', listId: todo, title: TITLE })
  await mutate(d, { type: 'card.update', id: card, patch: { dueAt: dayStart(0) } })
  ids = { boardId, todo, done, card }
  await handle.page.getByText(BOARD, { exact: true }).click()
  await expect(cardEl(handle.page, card)).toBeVisible()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

const cardEl = (page: Page, id: string): Locator => page.locator(`[data-card-id="${id}"]`)
const cardsTitled = (page: Page): Locator =>
  page.locator('[data-card-id]').filter({ hasText: TITLE })

async function makeWeekly(page: Page): Promise<void> {
  await cardEl(page, ids.card).click({ button: 'right' })
  // Repeat is a fly-out row in the card menu.
  await page.getByRole('button', { name: /^Repeat/ }).click()
  await page.getByRole('group', { name: 'Repeat' }).getByRole('button', { name: 'Weekly' }).click()
  await expect(
    cardEl(page, ids.card).getByRole('img', { name: 'Repeats every week' })
  ).toBeVisible()
}

test('completing a weekly card adds next week\'s, and Ctrl+Z takes both back', async () => {
  const { page } = handle
  await makeWeekly(page)

  await cardEl(page, ids.card).click()
  const detail = page.getByRole('dialog', { name: TITLE })
  await expect(detail.getByText('Every week', { exact: true })).toBeVisible()
  await detail.getByRole('checkbox', { name: /mark complete/i }).click()
  await page.keyboard.press('Escape')

  await expect(cardsTitled(page)).toHaveCount(2)
  const view = await rpc<{
    lists: Array<{ id: string; cards: Array<{ id: string; completed: boolean; dueAt: number | null; repeat: unknown }> }>
  }>(d, 'board.getView', { boardId: ids.boardId })
  const todo = view.lists.find((l) => l.id === ids.todo)!.cards
  expect(todo.map((c) => c.completed)).toEqual([true, false])
  expect(todo[1]!.dueAt).toBe(dayStart(7))
  expect(todo[1]!.repeat).toEqual({ unit: 'week', every: 1 })
  expect(todo[0]!.repeat).toBeNull()

  await page.keyboard.press('Control+z')
  await expect(cardsTitled(page)).toHaveCount(1)
  const back = await rpc<{ completed: boolean; repeat: unknown }>(d, 'card.get', { id: ids.card })
  expect(back).toMatchObject({ completed: false, repeat: { unit: 'week', every: 1 } })
})

test('a card dropped into an auto-complete list comes back where it started', async () => {
  const { page } = handle
  await mutate(d, { type: 'list.update', id: ids.done, patch: { onEnter: { kind: 'complete' } } })
  await makeWeekly(page)
  // The move itself is the channel's (same recorded path as a drag).
  await mutate(d, { type: 'card.move', id: ids.card, toListId: ids.done })

  const todoList = page.locator('section').filter({ has: page.getByRole('heading', { name: /^To do/ }) })
  const doneList = page.locator('section').filter({ has: page.getByRole('heading', { name: /^Done/ }) })
  await expect(doneList.locator('[data-card-id]').filter({ hasText: TITLE })).toHaveCount(1)
  await expect(todoList.locator('[data-card-id]').filter({ hasText: TITLE })).toHaveCount(1)
})
