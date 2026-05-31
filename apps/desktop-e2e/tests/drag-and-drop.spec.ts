import { expect, test, type Locator } from '@playwright/test'
import { launchKanbini, type E2EHandle } from './_launch.js'

// E2E for dnd-kit cross-list card drags. The pure projections that
// power onDragOver / onDragEnd live in `lib/board-dnd.ts` and are
// unit-tested there (43 + 12 tests); this suite exercises the
// integration through real PointerEvents so the PointerSensor's
// 6 px activation constraint, the optimistic cache write, the
// card.move IPC, and the post-drop broadcastChange refetch are all
// on the path.
//
// dnd-kit listens for pointer events, not bare mouse events. Chromium
// usually synthesizes pointer events from mouse events, but the
// PointerSensor needs MULTIPLE pointermove events past the 6 px
// activation distance - a single jump isn't enough. Playwright's
// `mouse.move(..., { steps: N })` interpolates N pointermove events
// between the current position and the target, which is exactly what
// dnd-kit wants.

let handle: E2EHandle

test.beforeEach(async () => {
  handle = await launchKanbini()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

/** Pick the cards-ul of a specific list by anchoring on a known-
 *  stable card in that list. ListColumn renders the cards as a
 *  <ul role="list">; we use it as the scoping unit (rather than the
 *  outer column div, which is tricky to target unambiguously). The
 *  anchor card MUST be one that doesn't move during the test. */
function cardsListWith(
  page: E2EHandle['page'],
  anchorCardTitle: string
): Locator {
  return page.getByRole('list').filter({ hasText: anchorCardTitle })
}

/** Drive a real PointerEvent-backed drag from one element to another.
 *  Uses 25 interpolated steps so dnd-kit's PointerSensor sees more
 *  than enough pointermove events to clear the 6 px activation
 *  threshold + register a meaningful drag delta. */
async function dragBetween(
  page: E2EHandle['page'],
  from: Locator,
  to: Locator
): Promise<void> {
  const fromBox = await from.boundingBox()
  const toBox = await to.boundingBox()
  if (!fromBox || !toBox) {
    throw new Error('boundingBox unavailable for drag source or target')
  }
  const start = {
    x: fromBox.x + fromBox.width / 2,
    y: fromBox.y + fromBox.height / 2
  }
  const end = {
    x: toBox.x + toBox.width / 2,
    y: toBox.y + toBox.height / 2
  }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  // First nudge past the activation threshold so the PointerSensor
  // commits to the drag before we move toward the target.
  await page.mouse.move(start.x + 12, start.y + 12, { steps: 5 })
  // Then glide to the destination.
  await page.mouse.move(end.x, end.y, { steps: 25 })
  await page.mouse.up()
}

test('drag a card from To Do into In Progress', async () => {
  const { page } = handle

  // Open the seeded Welcome Board.
  await page.getByText('Welcome Board', { exact: true }).click()
  await expect(page.getByRole('heading', { name: /^To Do\b/ })).toBeVisible()
  await expect(
    page.getByRole('heading', { name: /^In Progress\b/ })
  ).toBeVisible()

  // Anchor each list on a stable card that won't move this test.
  const todoCards = cardsListWith(page, 'Click the checkbox to complete me')
  const inProgressCards = cardsListWith(page, 'Try the label filter above')

  // Source card lives in To Do; target is the stable card in In
  // Progress.
  const movingCard = todoCards.locator(
    '[data-card-id]', { hasText: 'Drag a card to another list' }
  )
  const targetCard = inProgressCards.locator(
    '[data-card-id]', { hasText: 'Try the label filter above' }
  )
  await expect(movingCard).toBeVisible()
  await expect(targetCard).toBeVisible()

  await dragBetween(page, movingCard, targetCard)

  // After the drop: the card now sits in the In Progress cards-ul
  // AND no longer in the To Do cards-ul. Both halves matter - the
  // negative half catches a duplicate-card bug.
  await expect(
    inProgressCards.locator('[data-card-id]', {
      hasText: 'Drag a card to another list'
    })
  ).toBeVisible()
  await expect(
    todoCards.locator('[data-card-id]', {
      hasText: 'Drag a card to another list'
    })
  ).toHaveCount(0)
})

test('drag a card onto an empty target list (Done is empty after the seed clears)', async () => {
  const { page } = handle

  await page.getByText('Welcome Board', { exact: true }).click()

  // The seed gives "Done" exactly one card ("Scaffold the stack
  // (M0)"). Delete it first so we can drop onto a known-empty list
  // - exercises the "+ Add a card" list-end droppable path.
  await page
    .getByText('Scaffold the stack (M0)', { exact: true })
    .click({ button: 'right' })
  await page.getByRole('button', { name: 'Delete card' }).click()
  await expect(
    page.getByText('Scaffold the stack (M0)', { exact: true })
  ).toHaveCount(0)

  const todoCards = cardsListWith(page, 'Click the checkbox to complete me')
  const movingCard = todoCards.locator(
    '[data-card-id]', { hasText: 'Drag a card to another list' }
  )
  // Empty-list drop target: the AddCard placeholder inside the Done
  // column doubles as the drop area (the column itself is the
  // useDroppable target with id `list:<id>`). Done is now empty so
  // we can't anchor by a card - find its "+ Add a card" textbox by
  // proximity to the Done heading via `getByRole('main')` scope.
  const doneAddCard = page
    .getByRole('main')
    .getByPlaceholder('+ Add a card')
    .nth(2) // To Do, In Progress, Done - Done is the third add box
  await expect(movingCard).toBeVisible()
  await expect(doneAddCard).toBeVisible()

  await dragBetween(page, movingCard, doneAddCard)

  // After the drop, the card lives in the Done cards-ul (now
  // anchorable on itself since it's the only card there) AND is
  // gone from the To Do cards-ul.
  const doneCards = cardsListWith(page, 'Drag a card to another list')
  await expect(doneCards).toBeVisible()
  await expect(
    todoCards.locator('[data-card-id]', {
      hasText: 'Drag a card to another list'
    })
  ).toHaveCount(0)
})
