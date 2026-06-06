import { expect, test, type Page } from '@playwright/test'
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

/** Open the list pencil menu and click a "Sort cards" chip. */
async function setSort(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: 'Edit list' }).click()
  await page.getByRole('button', { name: label, exact: true }).click()
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
