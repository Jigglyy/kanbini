import { expect, test } from '@playwright/test'
import { launchKanbini, type E2EHandle } from './_launch.js'

// Regression for the "screen snaps up and fixes itself" bug: scroll the
// board down, then a card ABOVE the viewport changes height (its title
// un/wraps as the hover checkbox column reveals) and the whole visible
// region shifted by one line. scrollTop never changed - it's the raw
// reflow of an off-screen-above element - so it's invisible to scroll
// listeners; the symptom is the on-screen position of a VISIBLE card
// jumping. useSmoothHeight now compensates the scroll container's
// scrollTop by the off-screen delta so nothing visibly moves.
//
// The check measures a visible reference card's viewport-top before and
// during a forced height change on a card scrolled above the fold, and
// asserts the excursion stays ~0 (was ~20px before the fix).

let handle: E2EHandle

test.beforeEach(async () => {
  handle = await launchKanbini()
})
test.afterEach(async () => {
  await handle?.cleanup()
})

async function addCard(page: E2EHandle['page'], title: string) {
  await page.getByPlaceholder('+ Add a card').first().click()
  await page.keyboard.type(title)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(80)
}

test('a card changing height above the viewport does not shift visible content', async () => {
  const { page } = handle
  await page.setViewportSize({ width: 760, height: 300 })
  await page.getByText('Welcome Board', { exact: true }).click()
  await expect(page.getByRole('heading', { name: /^To Do\b/ })).toBeVisible()

  // Card A (top) is tall; several fillers below so the list overflows and
  // we can scroll A above the fold and still see a reference card.
  await addCard(page, 'AAAA top card')
  for (let i = 0; i < 8; i++) await addCard(page, `filler ${i}`)

  const excursion = await page.evaluate(async () => {
    const main = document.querySelector('main') as HTMLElement
    const cards = Array.from(
      document.querySelectorAll('[data-card-id]')
    ) as HTMLElement[]
    const a = cards.find((c) => (c.textContent ?? '').includes('AAAA'))!

    // Scroll so A is fully above the visible top of the scroll container.
    main.scrollTop = main.scrollHeight - main.clientHeight
    await new Promise((r) => requestAnimationFrame(() => r(null)))

    const scTop = main.getBoundingClientRect().top
    // Reference = a card currently fully visible inside the container.
    const ref = cards.find((c) => {
      const r = c.getBoundingClientRect()
      return r.top >= scTop && r.bottom <= main.getBoundingClientRect().bottom
    })!
    const refTop = (): number => ref.getBoundingClientRect().top
    const before = refTop()

    // Force A (above the fold) to grow by a line - the ResizeObserver in
    // useSmoothHeight should compensate scrollTop so `ref` doesn't move.
    const samples: number[] = []
    let frames = 0
    const poll = (): void => {
      samples.push(refTop())
      if (++frames < 40) requestAnimationFrame(poll)
    }
    requestAnimationFrame(poll)
    a.style.minHeight = `${a.offsetHeight + 24}px`
    await new Promise((r) => setTimeout(r, 350))

    const all = [before, ...samples]
    return {
      excursion: Math.max(...all) - Math.min(...all),
      // Sanity: the scenario actually held (A above the fold, a visible
      // reference card existed) - guards against a future layout change
      // making this a no-op test that passes for the wrong reason.
      aAboveFold: a.getBoundingClientRect().bottom <= scTop,
      refFound: !!ref
    }
  })

  expect(excursion.aAboveFold).toBe(true)
  expect(excursion.refFound).toBe(true)
  // Before the fix this was ~20-24px; allow a small tolerance for
  // sub-pixel rounding across frames.
  expect(excursion.excursion).toBeLessThanOrEqual(2)
})
