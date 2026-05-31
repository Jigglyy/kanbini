import { expect, test, type Locator } from '@playwright/test'
import { launchKanbini, type E2EHandle } from './_launch.js'

// E2E for drag-to-reorder of the header label filter chips (ADR-0062
// follow-up). The pure projection lives in `lib/label-order.ts`
// (projectReorder / reorderLabels, unit-tested); this drives the real
// PointerSensor through dnd-kit so the 6 px activation constraint, the
// onDragEnd -> reorderLabels persist, and the applyLabelOrder re-render
// are all on the path. Order is a renderer-only localStorage pref (not
// a DB column), and the post-drop re-render reads it straight back via
// applyLabelOrder - so the visible swap below also proves the
// localStorage round-trip.

let handle: E2EHandle

test.beforeEach(async () => {
  handle = await launchKanbini()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

/** Drive a real PointerEvent-backed drag from one chip to another. Same
 *  shape as the card drag-and-drop spec: nudge past the 6 px activation
 *  threshold first, then glide to the target with interpolated steps so
 *  dnd-kit's PointerSensor sees enough pointermove events. */
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
  const end = { x: toBox.x + toBox.width / 2, y: toBox.y + toBox.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 12, start.y + 12, { steps: 5 })
  await page.mouse.move(end.x, end.y, { steps: 25 })
  await page.mouse.up()
}

async function createLabel(
  page: E2EHandle['page'],
  name: string
): Promise<void> {
  await page.getByRole('button', { name: /new label/i }).click()
  await page.getByPlaceholder('Label name').fill(name)
  await page.getByRole('button', { name: /add label/i }).click()
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
}

/** Reading-order position of a chip: earlier row wins, else further left.
 *  Tolerant of the bar wrapping onto a second line. */
async function chipPos(
  page: E2EHandle['page'],
  name: string
): Promise<{ x: number; y: number }> {
  const box = await page
    .getByRole('button', { name, exact: true })
    .boundingBox()
  if (!box) throw new Error(`no chip for ${name}`)
  return { x: box.x, y: box.y }
}

function isBefore(
  a: { x: number; y: number },
  b: { x: number; y: number }
): boolean {
  if (Math.abs(a.y - b.y) > 5) return a.y < b.y
  return a.x < b.x
}

test('drag a label chip before another to reorder the filter bar', async () => {
  const { page } = handle

  await page.getByText('Welcome Board', { exact: true }).click()
  await expect(page.getByRole('heading', { name: /^To Do\b/ })).toBeVisible()

  // Two fresh chips, appended in creation order: Alpha then Beta.
  await createLabel(page, 'Alpha')
  await createLabel(page, 'Beta')
  expect(
    isBefore(await chipPos(page, 'Alpha'), await chipPos(page, 'Beta'))
  ).toBe(true)

  // Drag Beta onto Alpha's slot -> Beta should land before Alpha.
  await dragBetween(
    page,
    page.getByRole('button', { name: 'Beta', exact: true }),
    page.getByRole('button', { name: 'Alpha', exact: true })
  )

  await expect
    .poll(async () =>
      isBefore(await chipPos(page, 'Beta'), await chipPos(page, 'Alpha'))
    )
    .toBe(true)
})
