import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchKanbini, type E2EHandle } from './_launch.js'
import { mutate, rpc, waitForDiscovery, type Discovery } from './_channel.js'

// E2E for collapsible cards + a list's compact mode. A compact card drops
// its cover, URL chip, and checklist items and shows count badges
// instead; the per-card collapse is three-state (null follows the list).
// Data is seeded over the control channel so each test starts from a
// card that has a checklist and a comment, which is what compact hides.

let handle: E2EHandle
let d: Discovery
let ids: { boardId: string; listId: string; rich: string; plain: string }

const BOARD = 'Collapse E2E'
const RICH = 'Card with a checklist'
const PLAIN = 'Plain card'

test.beforeEach(async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'kanbini-e2e-collapse-'))
  handle = await launchKanbini({ userDataDir })
  d = await waitForDiscovery(userDataDir)

  const boardId = await mutate(d, { type: 'board.create', name: BOARD })
  const listId = await mutate(d, { type: 'list.create', boardId, name: 'Todo' })
  const rich = await mutate(d, { type: 'card.create', listId, title: RICH })
  const plain = await mutate(d, { type: 'card.create', listId, title: PLAIN })
  const checklistId = await mutate(d, { type: 'checklist.create', cardId: rich, name: 'Steps' })
  const first = await mutate(d, { type: 'checklistItem.create', checklistId, text: 'One' })
  await mutate(d, { type: 'checklistItem.create', checklistId, text: 'Two' })
  await mutate(d, { type: 'checklistItem.update', id: first, patch: { completed: true } })
  await mutate(d, { type: 'comment.create', cardId: rich, body: 'A note' })
  ids = { boardId, listId, rich, plain }

  await handle.page.getByText(BOARD, { exact: true }).click()
  await expect(cardEl(handle.page, rich)).toBeVisible()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

const cardEl = (page: Page, id: string): Locator =>
  page.locator(`[data-card-id="${id}"]`)

/** Full cards show the checklist preview; compact ones don't. */
const checklistPreview = (card: Locator): Locator =>
  card.getByRole('button', { name: /checklist/i })

async function storedCollapsed(id: string): Promise<boolean | null> {
  const card = await rpc<{ collapsed: boolean | null }>(d, 'card.get', { id })
  return card.collapsed
}

test('the hover chevron collapses a card to a summary and expands it back', async () => {
  const { page } = handle
  const rich = cardEl(page, ids.rich)
  await expect(checklistPreview(rich)).toHaveCount(1)

  await rich.hover()
  await rich.getByRole('button', { name: 'Collapse card' }).click()

  await expect(checklistPreview(rich)).toHaveCount(0)
  await expect(rich.getByTitle('1 of 2 checklist items done')).toHaveText('1/2')
  await expect(rich.getByTitle('1 comment')).toBeVisible()
  await expect.poll(() => storedCollapsed(ids.rich)).toBe(true)

  await rich.hover()
  await rich.getByRole('button', { name: 'Expand card' }).click()
  await expect(checklistPreview(rich)).toHaveCount(1)
  // Back to matching its (full) list, so nothing is stored.
  await expect.poll(() => storedCollapsed(ids.rich)).toBeNull()
})

test('a collapse survives leaving and reopening the board', async () => {
  const { page } = handle
  const rich = cardEl(page, ids.rich)
  await rich.hover()
  await rich.getByRole('button', { name: 'Collapse card' }).click()
  await expect(checklistPreview(rich)).toHaveCount(0)

  await page.keyboard.press('Alt+b') // nav.home
  await expect(page.getByText(BOARD, { exact: true })).toBeVisible()
  await page.getByText(BOARD, { exact: true }).click()
  await expect(cardEl(page, ids.rich)).toBeVisible()
  await expect(checklistPreview(cardEl(page, ids.rich))).toHaveCount(0)
})

test('a compact list compacts every card, and one card can stay open', async () => {
  const { page } = handle
  await page.getByRole('button', { name: 'Edit list' }).click()
  await page.getByRole('button', { name: 'Compact', exact: true }).click()

  const rich = cardEl(page, ids.rich)
  await expect(checklistPreview(rich)).toHaveCount(0)
  await expect(rich.getByTitle('1 comment')).toBeVisible()

  // Expand just this one inside the compact list.
  await rich.hover()
  await rich.getByRole('button', { name: 'Expand card' }).click()
  await expect(checklistPreview(rich)).toHaveCount(1)
  await expect.poll(() => storedCollapsed(ids.rich)).toBe(false)
  // The other card keeps following the list.
  await expect.poll(() => storedCollapsed(ids.plain)).toBeNull()
  const plain = cardEl(page, ids.plain)
  await plain.hover()
  await expect(plain.getByRole('button', { name: 'Expand card' })).toBeVisible()
})

test('m collapses and expands the focused card', async () => {
  const { page } = handle
  const rich = cardEl(page, ids.rich)
  // A click focuses the card (and opens the detail); Escape closes it.
  await rich.click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: RICH })).not.toBeVisible()

  await page.keyboard.press('m')
  await expect(checklistPreview(rich)).toHaveCount(0)
  await page.keyboard.press('m')
  await expect(checklistPreview(rich)).toHaveCount(1)
})

test('the right-click menu collapses a card', async () => {
  const { page } = handle
  const rich = cardEl(page, ids.rich)
  await rich.click({ button: 'right' })
  await page.getByText('Collapse card', { exact: true }).click()
  await expect(checklistPreview(rich)).toHaveCount(0)
})

test('dragging a collapsed card keeps the drag preview compact', async () => {
  const { page } = handle
  const rich = cardEl(page, ids.rich)
  await rich.hover()
  await rich.getByRole('button', { name: 'Collapse card' }).click()
  await expect(checklistPreview(rich)).toHaveCount(0)

  const box = (await rich.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 + 12, {
    steps: 5
  })
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 60, {
    steps: 10
  })
  // The overlay is the body-portaled clone under the cursor.
  const overlay = page.locator('.group\\/dragoverlay')
  await expect(overlay).toBeVisible()
  await expect(overlay.getByText(RICH)).toBeVisible()
  await expect(overlay.getByTitle('1 of 2 checklist items done')).toBeVisible()
  await expect(overlay.getByRole('button', { name: /checklist/i })).toHaveCount(0)
  await page.mouse.up()
})
