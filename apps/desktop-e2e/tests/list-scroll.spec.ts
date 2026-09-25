import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchKanbini, type E2EHandle } from './_launch.js'
import { mutate, rpc, waitForDiscovery, type Discovery } from './_channel.js'

// E2E for lists that scroll on their own (settings.listsScrollSeparately,
// on by default). Each column caps to the board's height and only its
// card body scrolls, so one long list no longer scrolls every other
// list's header off screen. Data is seeded over the control channel.

let handle: E2EHandle
let d: Discovery
let ids: {
  boardId: string
  longId: string
  shortId: string
  cards: string[]
  onlyId: string
}

const BOARD = 'List scroll E2E'
const CARD_COUNT = 30

test.beforeEach(async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'kanbini-e2e-listscroll-'))
  handle = await launchKanbini({ userDataDir })
  await handle.page.setViewportSize({ width: 1000, height: 600 })
  d = await waitForDiscovery(userDataDir)
  const boardId = await mutate(d, { type: 'board.create', name: BOARD })
  const longId = await mutate(d, { type: 'list.create', boardId, name: 'Long' })
  const shortId = await mutate(d, { type: 'list.create', boardId, name: 'Short' })
  const cards: string[] = []
  for (let i = 0; i < CARD_COUNT; i++) {
    cards.push(
      await mutate(d, { type: 'card.create', listId: longId, title: `Card ${i + 1}` })
    )
  }
  const onlyId = await mutate(d, {
    type: 'card.create',
    listId: shortId,
    title: 'Only card'
  })
  ids = { boardId, longId, shortId, cards, onlyId }
  await handle.page.getByText(BOARD, { exact: true }).click()
  await expect(handle.page.getByText('Card 1', { exact: true })).toBeVisible()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

const body = (page: Page, listId: string): Locator =>
  page.locator(`[data-list-body="${listId}"]`)

async function scrollState(page: Page, listId: string) {
  return page.evaluate((id) => {
    const main = document.querySelector('main') as HTMLElement
    const ul = document.querySelector(`[data-list-body="${id}"]`) as HTMLElement
    return {
      mainOverflowsY: main.scrollHeight > main.clientHeight + 1,
      bodyOverflowsY: ul.scrollHeight > ul.clientHeight + 1,
      bodyScrollTop: ul.scrollTop
    }
  }, listId)
}

async function orderIn(listId: string): Promise<string[]> {
  const view = await rpc<{ lists: Array<{ id: string; cards: Array<{ title: string }> }> }>(
    d,
    'board.getView',
    { boardId: ids.boardId }
  )
  return view.lists.find((l) => l.id === listId)!.cards.map((c) => c.title)
}

test('a long list scrolls inside its column; the board does not', async () => {
  const { page } = handle
  const s = await scrollState(page, ids.longId)
  expect(s.bodyOverflowsY).toBe(true)
  expect(s.mainOverflowsY).toBe(false)

  // Scroll the long list to the bottom: its header, its "Add a card",
  // and the other list all stay on screen.
  await body(page, ids.longId).evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await expect(page.getByText(`Card ${CARD_COUNT}`, { exact: true })).toBeInViewport()
  await expect(page.getByRole('heading', { name: /^Long\b/ })).toBeInViewport()
  await expect(page.getByRole('heading', { name: /^Short\b/ })).toBeInViewport()
  await expect(page.getByPlaceholder('+ Add a card').first()).toBeInViewport()
})

test('cards keep their natural height inside a scrolled list', async () => {
  // Regression: a card <li> is overflow-hidden, which drops its automatic
  // min-height to 0, so a height-capped body squashed every card to fit
  // (titles clipped) instead of scrolling. Same one-line title in both
  // lists -> the same height.
  const { page } = handle
  const inLong = (await page.locator(`[data-card-id="${ids.cards[0]}"]`).boundingBox())!
  const inShort = (await page.locator(`[data-card-id="${ids.onlyId}"]`).boundingBox())!
  expect(Math.abs(inLong.height - inShort.height)).toBeLessThanOrEqual(1)
})

test('keyboard focus scrolls the list body to the focused card', async () => {
  const { page } = handle
  await page.getByText('Card 1', { exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Card 1' })).not.toBeVisible()
  for (let i = 0; i < CARD_COUNT - 1; i++) await page.keyboard.press('j')
  await expect(page.getByText(`Card ${CARD_COUNT}`, { exact: true })).toBeInViewport()
  expect((await scrollState(page, ids.longId)).bodyScrollTop).toBeGreaterThan(0)
})

test('a card dropped into a scrolled list lands exactly where it was shown', async () => {
  // "Drop = what you saw": the slot the live preview showed just before
  // release must be the slot that's saved. If the scroll offset of the
  // list body confused dnd-kit's measurements, these two would differ.
  const { page } = handle
  await body(page, ids.longId).evaluate((el) => {
    el.scrollTop = el.scrollHeight / 2
  })
  // Aim at the card nearest the MIDDLE of the visible body. Near either
  // edge, dnd-kit's auto-scroll (20% of the container) would legitimately
  // scroll the list while the card is held, moving the slot with it.
  const bodyBox = (await body(page, ids.longId).boundingBox())!
  const midId = await page.evaluate(
    ({ longId, y }) =>
      (
        Array.from(
          document.querySelectorAll(`[data-list-body="${longId}"] [data-card-id]`)
        ) as HTMLElement[]
      )
        .sort(
          (a, b) =>
            Math.abs(a.getBoundingClientRect().top - y) -
            Math.abs(b.getBoundingClientRect().top - y)
        )[0]!
        .getAttribute('data-card-id')!,
    { longId: ids.longId, y: bodyBox.y + bodyBox.height / 2 }
  )
  const target = page.locator(`[data-card-id="${midId}"]`)
  await expect(target).toBeInViewport()
  const from = (await page.getByText('Only card', { exact: true }).boundingBox())!
  const to = (await target.boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + 12, { steps: 5 })
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 25 })
  await page.waitForTimeout(150)

  const shown = await page.evaluate(
    ({ longId, onlyId }) =>
      Array.from(
        document.querySelectorAll(`[data-list-body="${longId}"] [data-card-id]`)
      ).findIndex((el) => el.getAttribute('data-card-id') === onlyId),
    { longId: ids.longId, onlyId: ids.onlyId }
  )
  // It really did move into the middle of the long list, past the part
  // that was scrolled away.
  expect(shown).toBeGreaterThan(8)
  await page.mouse.up()

  await expect.poll(() => orderIn(ids.longId)).toContain('Only card')
  expect((await orderIn(ids.longId)).indexOf('Only card')).toBe(shown)
})

test('dragging near the bottom of a long list auto-scrolls it', async () => {
  const { page } = handle
  const bodyBox = (await body(page, ids.longId).boundingBox())!
  const first = (await page.getByText('Card 1', { exact: true }).boundingBox())!
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2)
  await page.mouse.down()
  await page.mouse.move(first.x + first.width / 2, first.y + 20, { steps: 5 })
  // Hold just inside the body's bottom edge.
  await page.mouse.move(bodyBox.x + bodyBox.width / 2, bodyBox.y + bodyBox.height - 8, {
    steps: 15
  })
  await expect
    .poll(async () => (await scrollState(page, ids.longId)).bodyScrollTop, {
      timeout: 5000
    })
    .toBeGreaterThan(100)
  await page.keyboard.press('Escape') // cancel the drag
  await page.mouse.up()
})

test('turning the setting off restores full-length lists', async () => {
  const { page } = handle
  await page.evaluate(() => {
    const key = 'kanbini.settings'
    const s = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>
    s['listsScrollSeparately'] = false
    localStorage.setItem(key, JSON.stringify(s))
  })
  await page.reload()
  await page.getByText(BOARD, { exact: true }).click()
  await expect(page.getByText('Card 1', { exact: true })).toBeVisible()
  const s = await scrollState(page, ids.longId)
  expect(s.bodyOverflowsY).toBe(false)
  expect(s.mainOverflowsY).toBe(true)
})
