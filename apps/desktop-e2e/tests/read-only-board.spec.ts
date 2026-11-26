import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchKanbini, type E2EHandle } from './_launch.js'
import { mutate, rpc, waitForDiscovery, type Discovery } from './_channel.js'

// A locked board (renderer-only, lib/read-only.ts) refuses YOUR edits -
// typing, drags, shortcuts - but still takes your ticks (a checklist
// item, a card's "Mark complete"), while the AI, writing through the
// control channel, still changes it live. The lock is per board and
// survives a reload; unlocking gives editing back.

let handle: E2EHandle

test.afterEach(async () => {
  await handle?.cleanup()
})

interface ViewLite {
  lists: Array<{ id: string; name: string; cards: Array<{ id: string; title: string; completed: boolean }> }>
}
interface CardLite {
  completed: boolean
  checklists: Array<{ items: Array<{ id: string; completed: boolean }> }>
}

const card = (page: Page, text: string): Locator =>
  page.locator('li[data-card-id]', { hasText: text })
const cardsListWith = (page: Page, anchor: string): Locator =>
  page.getByRole('list').filter({ hasText: anchor })

async function openWelcome(page: Page): Promise<void> {
  await page.getByText('Welcome Board', { exact: true }).click()
  await expect(page.getByRole('heading', { name: /^To Do\b/ })).toBeVisible()
}

async function drag(page: Page, from: Locator, to: Locator): Promise<void> {
  const a = (await from.boundingBox())!
  const b = (await to.boundingBox())!
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2 + 12, { steps: 5 })
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 25 })
  await page.mouse.up()
}

test('a locked board refuses your edits, takes the AI’s, and survives a reload', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'kanbini-e2e-ro-'))
  handle = await launchKanbini({ userDataDir })
  const { page } = handle
  const d = await waitForDiscovery(userDataDir)
  const boards = await rpc<Array<{ id: string; name: string }>>(d, 'boards.list', {})
  const boardId = boards.find((b) => b.name === 'Welcome Board')!.id
  const view = (): Promise<ViewLite> => rpc<ViewLite>(d, 'board.getView', { boardId })

  await openWelcome(page)
  await expect(page.getByPlaceholder('+ Add a card').first()).toBeVisible()

  // A checklist to tick once the board is locked.
  const target = 'Click the checkbox to complete me'
  const targetId = (await view()).lists.flatMap((l) => l.cards).find((c) => c.title === target)!.id
  const checklistId = await mutate(d, { type: 'checklist.create', cardId: targetId, name: 'Steps' })
  const itemId = await mutate(d, { type: 'checklistItem.create', checklistId, text: 'First step' })
  const stored = (): Promise<CardLite> => rpc<CardLite>(d, 'card.get', { id: targetId })

  // Lock it.
  await page.getByRole('button', { name: 'Lock board (read-only)' }).click()
  await expect(page.getByRole('button', { name: 'Unlock board' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('read-only-pill')).toBeVisible()
  await expect(page.getByPlaceholder('+ Add a card')).toHaveCount(0)
  await expect(page.getByPlaceholder('+ Add a list')).toHaveCount(0)

  // A drag leaves the card where it was (on screen and in the DB).
  const dragged = 'Drag a card to another list'
  await drag(page, card(page, dragged), card(page, 'Try the label filter above'))
  await page.waitForTimeout(400)
  await expect(cardsListWith(page, 'Click the checkbox to complete me')).toContainText(dragged)
  const toDo = (await view()).lists.find((l) => l.name === 'To Do')!
  expect(toDo.cards.map((c) => c.title)).toContain(dragged)

  // Opening a card works; its title can't be typed into.
  await card(page, target).click()
  const dialog = page.getByRole('dialog', { name: target })
  await expect(dialog).toBeVisible()
  const title = dialog.getByRole('textbox').first()
  await expect(title).toHaveValue(target)
  await expect(title).toHaveAttribute('readonly', '')
  await expect(dialog.getByTestId('read-only-pill')).toBeVisible()

  // Ticks still go through: the checklist item, then the card itself.
  await dialog.getByRole('button', { name: 'Mark complete' }).click()
  await expect.poll(async () => (await stored()).checklists[0]!.items[0]!).toMatchObject({ id: itemId, completed: true })
  await dialog.getByRole('checkbox', { name: 'Mark complete' }).click()
  await expect.poll(async () => (await stored()).completed).toBe(true)
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()

  // The card is focused (the click set it): Delete does nothing.
  await page.keyboard.press('Delete')
  await page.waitForTimeout(400)
  await expect(card(page, target)).toHaveCount(1)
  expect((await view()).lists.flatMap((l) => l.cards).map((c) => c.id)).toContain(targetId)

  // The AI's write lands and shows up on the locked board.
  const created = await mutate(d, { type: 'card.create', listId: toDo.id, title: 'Written by the AI' })
  expect(created).toBeTruthy()
  await expect(card(page, 'Written by the AI')).toBeVisible()

  // Ctrl+Z from home (no board in scope) takes the newest entry on any
  // board - here the AI's card on the locked board. It must not.
  await page.keyboard.press('Escape')
  await expect(page.getByText('Welcome Board', { exact: true })).toBeVisible()
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(500)
  const titles = (await view()).lists.flatMap((l) => l.cards.map((c) => c.title))
  expect(titles).toContain('Written by the AI')
  await expect(page.getByRole('heading', { name: /^To Do\b/ })).toHaveCount(0)

  // The lock survives a reload (and shows on the home tile).
  await page.reload()
  await expect(page.getByRole('img', { name: 'Read-only' })).toBeVisible()
  await openWelcome(page)
  await expect(page.getByRole('button', { name: 'Unlock board' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByPlaceholder('+ Add a card')).toHaveCount(0)

  // Unlocking gives editing back.
  await page.getByRole('button', { name: 'Unlock board' }).click()
  await expect(page.getByTestId('read-only-pill')).toHaveCount(0)
  const add = page.getByPlaceholder('+ Add a card').first()
  await add.fill('Mine again')
  await add.press('Enter')
  await expect(card(page, 'Mine again')).toBeVisible()
})

// ─── Follow-ups (board card #12) ───────────────────────────────────

/** A fresh data folder with Welcome Board open; returns the channel. */
async function openFresh(): Promise<{ page: Page; d: Discovery; welcomeId: string }> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'kanbini-e2e-ro-'))
  handle = await launchKanbini({ userDataDir })
  const d = await waitForDiscovery(userDataDir)
  const boards = await rpc<Array<{ id: string; name: string }>>(d, 'boards.list', {})
  const welcomeId = boards.find((b) => b.name === 'Welcome Board')!.id
  await openWelcome(handle.page)
  return { page: handle.page, d, welcomeId }
}

async function lockOpenBoard(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Lock board (read-only)' }).click()
  await expect(page.getByTestId('read-only-pill')).toBeVisible()
}

const menu = (page: Page): Locator => page.locator('[data-overlay="context-menu"]')

test('a locked board hides what it refuses and still takes view settings', async () => {
  const { page, d, welcomeId } = await openFresh()
  await lockOpenBoard(page)
  const title = 'Drag a card to another list'
  const view = await rpc<ViewLite>(d, 'board.getView', { boardId: welcomeId })
  const cardId = view.lists.flatMap((l) => l.cards).find((c) => c.title === title)!.id
  const toDoId = view.lists.find((l) => l.name === 'To Do')!.id

  // The card menu keeps only Collapse and Mark complete.
  await card(page, title).click({ button: 'right' })
  await expect(menu(page).getByRole('button', { name: 'Mark complete' })).toBeVisible()
  await expect(menu(page).getByRole('button', { name: /Delete card/ })).toHaveCount(0)
  await expect(menu(page).getByRole('button', { name: /^Labels/ })).toHaveCount(0)
  // Collapsing is a view setting: it goes through.
  await menu(page).getByRole('button', { name: 'Collapse card' }).click()
  await expect
    .poll(async () => (await rpc<{ collapsed: boolean | null }>(d, 'card.get', { id: cardId })).collapsed)
    .toBe(true)

  // The list menu: no colour / sort / delete, but "Show at most" works.
  await page.getByRole('button', { name: 'Edit list' }).first().click()
  await expect(menu(page).getByRole('button', { name: /^Colour/ })).toHaveCount(0)
  await expect(menu(page).getByRole('button', { name: /Delete list/ })).toHaveCount(0)
  await menu(page).getByRole('button', { name: /^Cards/ }).click()
  await page.getByRole('button', { name: 'Show at most 10 cards' }).click()
  await expect
    .poll(async () => {
      const v = await rpc<{ lists: Array<{ id: string; visibleCardLimit: number | null }> }>(
        d,
        'board.getView',
        { boardId: welcomeId }
      )
      return v.lists.find((l) => l.id === toDoId)!.visibleCardLimit
    })
    .toBe(10)
  // No "New label" in the label bar.
  await expect(page.getByRole('button', { name: /New label/ })).toHaveCount(0)
})

test('a Ctrl+Z that would change a locked board is refused, with a note', async () => {
  const { page, d, welcomeId } = await openFresh()
  const otherId = await mutate(d, { type: 'board.create', name: 'Other' })
  const inbox = await mutate(d, { type: 'list.create', boardId: otherId, name: 'Inbox' })
  const welcome = await rpc<ViewLite>(d, 'board.getView', { boardId: welcomeId })
  const moved = welcome.lists[0]!.cards[0]!
  const otherTitles = async (): Promise<string[]> =>
    (await rpc<ViewLite>(d, 'board.getView', { boardId: otherId })).lists.flatMap((l) =>
      l.cards.map((c) => c.title)
    )

  // Lock Other from its own header, then come back to Welcome.
  await page.keyboard.press('Alt+b')
  await page.getByText('Other', { exact: true }).click()
  await lockOpenBoard(page)
  await page.keyboard.press('Alt+b')
  await openWelcome(page)

  // The AI moves a Welcome card onto Other: the move is in Welcome's
  // history, but undoing it would take the card off the locked board.
  await mutate(d, { type: 'card.move', id: moved.id, toListId: inbox })
  await expect(card(page, moved.title)).toHaveCount(0)
  await page.keyboard.press('Control+z')
  const note = page.getByRole('status').filter({ hasText: 'Can’t undo' })
  await expect(note).toContainText('“Other”, which is locked')
  await page.waitForTimeout(300)
  expect(await otherTitles()).toContain(moved.title)

  // "Go to board" opens Other to unlock it; then the undo goes through.
  await note.getByRole('button', { name: 'Go to board' }).click()
  await page.getByRole('button', { name: 'Unlock board' }).click()
  await page.keyboard.press('Alt+b')
  await openWelcome(page)
  await page.keyboard.press('Control+z')
  await expect(card(page, moved.title)).toHaveCount(1)
  expect(await otherTitles()).not.toContain(moved.title)
})

test('a lock on a board the AI deleted is forgotten', async () => {
  const { page, d } = await openFresh()
  const tempId = await mutate(d, { type: 'board.create', name: 'Temp' })
  await page.keyboard.press('Alt+b')
  await page.getByText('Temp', { exact: true }).click()
  await lockOpenBoard(page)
  await page.keyboard.press('Alt+b')
  const locks = (): Promise<string[]> =>
    page.evaluate(() => JSON.parse(localStorage.getItem('kanbini.readOnlyBoards') ?? '[]'))
  expect(await locks()).toContain(tempId)
  await mutate(d, { type: 'board.delete', id: tempId })
  await expect.poll(locks).not.toContain(tempId)
})

test('a locked board can be grouped into swimlanes; nothing drags or adds there', async () => {
  const { page, d, welcomeId } = await openFresh()
  await lockOpenBoard(page)
  await page.getByRole('button', { name: 'Rename board' }).click()
  await page.getByRole('button', { name: 'Priority', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Urgent' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByPlaceholder('+ Add a card')).toHaveCount(0)

  const title = 'Drag a card to another list'
  const view = await rpc<ViewLite>(d, 'board.getView', { boardId: welcomeId })
  const cardId = view.lists.flatMap((l) => l.cards).find((c) => c.title === title)!.id
  await drag(page, card(page, title), page.getByRole('heading', { name: 'Urgent' }))
  await page.waitForTimeout(400)
  const stored = await rpc<{ priority: string | null }>(d, 'card.get', { id: cardId })
  expect(stored.priority).toBeNull()
})
