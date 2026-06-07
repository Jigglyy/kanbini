import { expect, test, type Locator, type Page } from '@playwright/test'
import { launchKanbini, type E2EHandle } from './_launch.js'

// E2E for per-list sort modes (ADR-0032 + follow-up). Builds a list with
// three cards in a deliberately unsorted order, then drives the list
// pencil menu's "Sort cards" picker through several modes and asserts the
// rendered card order. Also proves the header sort chip surfaces and that
// flipping back to Manual freezes whatever order the non-manual mode
// produced - the bug the follow-up fixed (the freeze used to assume
// created-date and would mis-freeze the other modes).

let handle: E2EHandle

test.beforeEach(async () => {
  handle = await launchKanbini()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

/** In-DOM order of the card titles in the (single) list. These cards
 *  carry no priority/labels, so a card's innerText is just its title. */
async function cardOrder(page: Page): Promise<string[]> {
  const cards = page.locator('[data-card-id]')
  return (await cards.allInnerTexts()).map((t) => t.trim()).filter(Boolean)
}

/** Open the list pencil menu and click a "Sort cards" chip. `which`
 *  selects the list when more than one "Edit list" button is present. */
async function setSort(
  page: Page,
  label: string,
  which = 0
): Promise<void> {
  await page.getByRole('button', { name: 'Edit list' }).nth(which).click()
  await page.getByRole('button', { name: label, exact: true }).click()
}

/** Real PointerEvent-backed drag (dnd-kit needs several interpolated
 *  pointermove events past its 6 px activation distance). Mirrors the
 *  helper in drag-and-drop.spec.ts. */
async function dragBetween(
  page: Page,
  from: Locator,
  to: Locator
): Promise<void> {
  const a = await from.boundingBox()
  const b = await to.boundingBox()
  if (!a || !b) throw new Error('boundingBox unavailable for drag')
  const sx = a.x + a.width / 2
  const sy = a.y + a.height / 2
  const ex = b.x + b.width / 2
  const ey = b.y + b.height / 2
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  await page.mouse.move(sx + 12, sy + 12, { steps: 5 })
  await page.mouse.move(ex, ey, { steps: 25 })
  await page.mouse.up()
}

test('sort modes reorder cards, show a header chip, and freeze on Manual', async () => {
  const { page } = handle

  // Fresh board so the three cards are the only ones on screen.
  await page.getByRole('button', { name: 'New board', exact: true }).click()
  await page
    .getByRole('dialog', { name: 'New board' })
    .getByRole('textbox', { name: 'Name' })
    .fill('Sort modes E2E')
  await page.getByRole('button', { name: 'Create board' }).click()

  // First list.
  await page.getByPlaceholder('List name').fill('Tasks')
  await page.getByRole('button', { name: /create first list/i }).click()
  await expect(page.getByRole('heading', { name: /^Tasks\b/ })).toBeVisible()

  // Add three cards in this order: Cherry, apple, Banana. Mixed case on
  // purpose so the alphabetical modes prove case-insensitivity.
  const addCard = page.getByPlaceholder('+ Add a card')
  for (const title of ['Cherry', 'apple', 'Banana']) {
    await addCard.click()
    await addCard.fill(title)
    await addCard.press('Enter')
    await expect(page.getByText(title, { exact: true })).toBeVisible()
  }

  // Manual = creation order to start.
  await expect
    .poll(() => cardOrder(page))
    .toEqual(['Cherry', 'apple', 'Banana'])

  // A to Z: case-insensitive -> apple, Banana, Cherry. Header chip shows.
  await setSort(page, 'A to Z')
  await expect
    .poll(() => cardOrder(page))
    .toEqual(['apple', 'Banana', 'Cherry'])
  await expect(page.getByText('A-Z', { exact: true })).toBeVisible()

  // Recently added: newest added to this list first -> Banana, apple,
  // Cherry (they were added Cherry, apple, Banana).
  await setSort(page, 'Recently added')
  await expect
    .poll(() => cardOrder(page))
    .toEqual(['Banana', 'apple', 'Cherry'])
  await expect(page.getByText('Recent', { exact: true })).toBeVisible()

  // Back to Manual freezes the *displayed* (recently-added) order, not
  // creation order. This is the flip-to-manual snapshot working for a
  // non-created mode (the follow-up's bug fix).
  await setSort(page, 'Manual')
  await expect(page.getByText('Recent', { exact: true })).toHaveCount(0)
  await expect
    .poll(() => cardOrder(page))
    .toEqual(['Banana', 'apple', 'Cherry'])
})

test('dragging a card into the middle of another sorted list moves it (no snap-back)', async () => {
  const { page } = handle

  await page.getByRole('button', { name: 'New board', exact: true }).click()
  await page
    .getByRole('dialog', { name: 'New board' })
    .getByRole('textbox', { name: 'Name' })
    .fill('Cross-list sorted drag')
  await page.getByRole('button', { name: 'Create board' }).click()

  // Source list with one card.
  await page.getByPlaceholder('List name').fill('Src')
  await page.getByRole('button', { name: /create first list/i }).click()
  await expect(page.getByRole('heading', { name: /^Src\b/ })).toBeVisible()
  const srcAdd = page.getByPlaceholder('+ Add a card')
  await srcAdd.click()
  await srcAdd.fill('MoveMe')
  await srcAdd.press('Enter')
  await expect(page.getByText('MoveMe', { exact: true })).toBeVisible()

  // Destination list with four cards (creation order Alpha..Delta).
  const addList = page.getByPlaceholder('+ Add a list')
  await addList.click()
  await addList.fill('Dst')
  await addList.press('Enter')
  await expect(page.getByRole('heading', { name: /^Dst\b/ })).toBeVisible()
  const dstAdd = page.getByRole('main').getByPlaceholder('+ Add a card').nth(1)
  for (const t of ['Alpha', 'Bravo', 'Charlie', 'Delta']) {
    await dstAdd.click()
    await dstAdd.fill(t)
    await dstAdd.press('Enter')
    await expect(page.getByText(t, { exact: true })).toBeVisible()
  }

  // Both lists sorted by "Recently added" (the reported context). Dst's
  // display becomes Delta, Charlie, Bravo, Alpha - the reverse of the
  // cards' fractional positions, which is what made a middle drop throw
  // server-side and snap the card back to its source list.
  await setSort(page, 'Recently added', 0) // Src
  await setSort(page, 'Recently added', 1) // Dst

  // Drag MoveMe (Src) onto Bravo - a middle card in the Dst display.
  const dstList = page.getByRole('list').filter({ hasText: 'Alpha' })
  const moving = page.locator('[data-card-id]', { hasText: 'MoveMe' })
  const target = dstList.locator('[data-card-id]', { hasText: 'Bravo' })
  await dragBetween(page, moving, target)

  // The move went through: MoveMe is now in Dst (top, freshest under
  // added-desc) and appears exactly once on the board - it did NOT snap
  // back to Src.
  await expect(
    dstList.locator('[data-card-id]', { hasText: 'MoveMe' })
  ).toBeVisible()
  await expect(
    page.locator('[data-card-id]', { hasText: 'MoveMe' })
  ).toHaveCount(1)
})
