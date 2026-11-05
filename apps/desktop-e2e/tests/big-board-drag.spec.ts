import { expect, test, type Locator, type Page } from '@playwright/test'
import { launchKanbini, type E2EHandle } from './_launch.js'

// Drags on a board with a 200-card list. Card drags score only the cards
// near the dragged one (closestCornersNearby, lib/collision.ts), and the
// long list scrolls on its own, so its cards' rects are scroll-adjusted:
// this pins that drops still land where the card was let go, at the top
// of the long list and deep in its scrolled part, across lists and
// within one. (The speed itself was measured by hand on a copy of a real
// 350-card board; see the commit that added this file.)

let handle: E2EHandle

interface Ids {
  boardId: string
}

test.beforeEach(async () => {
  handle = await launchKanbini()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

async function seedBigBoard(page: Page): Promise<Ids> {
  return page.evaluate(async () => {
    const k = (window as any).kanbini
    const [board] = await k.mutateBatch([{ type: 'board.create', name: 'Big board' }])
    const lists = await k.mutateBatch(
      ['Short', 'Long', 'Other'].map((name) => ({ type: 'list.create', boardId: board.id, name }))
    )
    const cards = (n: number, listId: string, prefix: string) =>
      Array.from({ length: n }, (_, i) => ({ type: 'card.create', listId, title: `${prefix} ${i + 1}` }))
    await k.mutateBatch([
      ...cards(5, lists[0].id, 'Short'),
      ...cards(200, lists[1].id, 'Long'),
      ...cards(3, lists[2].id, 'Other'),
      // Every card mounted: this is about drags among 200 real cards, not
      // the automatic "first 20" of a long list.
      { type: 'list.update', id: lists[1].id, patch: { visibleCardLimit: 0 } }
    ])
    return { boardId: board.id }
  })
}

/** Card titles per list, straight from the database. */
async function lists(page: Page, boardId: string): Promise<Record<string, string[]>> {
  return page.evaluate(async (id) => {
    const view = await (window as any).kanbini.getBoardView(id)
    return Object.fromEntries(
      view.lists.map((l: any) => [l.name, l.cards.map((c: any) => c.title)])
    )
  }, boardId)
}

const card = (page: Page, title: string): Locator =>
  page.locator('[data-card-id]').filter({ has: page.getByText(title, { exact: true }) })

async function drag(page: Page, from: Locator, to: Locator): Promise<void> {
  // Target first, then the source, so the card we press is on screen
  // (pairs are picked close enough that both are).
  await to.scrollIntoViewIfNeeded()
  await from.scrollIntoViewIfNeeded()
  await expect(to).toBeInViewport()
  const a = (await from.boundingBox())!
  const b = (await to.boundingBox())!
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2 + 12, { steps: 5 })
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 30 })
  await page.mouse.up()
  await expect(page.locator('.drag-overlay')).toHaveCount(0)
}

/** `moved` sits right next to `target` in `list`. */
function besides(order: string[], moved: string, target: string): boolean {
  const i = order.indexOf(moved)
  const j = order.indexOf(target)
  return i >= 0 && j >= 0 && Math.abs(i - j) === 1
}

test('cards land where they are dropped on a board with a 200-card list', async () => {
  const { page } = handle
  const { boardId } = await seedBigBoard(page)
  await page.getByRole('heading', { name: 'Big board', exact: true }).click()
  await expect(card(page, 'Long 1')).toBeVisible()

  // Into the top of the long list, from another list.
  await drag(page, card(page, 'Short 2'), card(page, 'Long 4'))
  await expect
    .poll(async () => {
      const l = await lists(page, boardId)
      return !l['Short']!.includes('Short 2') && besides(l['Long']!, 'Short 2', 'Long 4')
    })
    .toBe(true)

  // Deep in the long list's scrolled part, from another list.
  await drag(page, card(page, 'Other 1'), card(page, 'Long 150'))
  await expect
    .poll(async () => {
      const l = await lists(page, boardId)
      return !l['Other']!.includes('Other 1') && besides(l['Long']!, 'Other 1', 'Long 150')
    })
    .toBe(true)

  // Within the long list, down in its scrolled part.
  await drag(page, card(page, 'Long 160'), card(page, 'Long 164'))
  await expect
    .poll(async () => besides((await lists(page, boardId))['Long']!, 'Long 160', 'Long 164'))
    .toBe(true)
  const long = (await lists(page, boardId))['Long']!
  expect(long).toHaveLength(202)
  expect(long.indexOf('Long 160')).toBeGreaterThan(long.indexOf('Long 161'))
})
