import { expect, test, type Locator, type Page } from '@playwright/test'
import { launchKanbini, type E2EHandle } from './_launch.js'

// E2E for the Markdown editor toolbar Link control (ADR-0058). It's a
// Popover URL input, NOT window.prompt - Electron disables prompt() in
// the renderer, so the old button was a dead no-op in the packaged app
// (and the unit tests couldn't catch it because they mocked prompt).
// These run against the REAL Electron renderer, so they exercise the
// exact path that was broken, plus the overlay-aware dismissal that
// keeps the portaled popover from tearing the editor / modal down.

let handle: E2EHandle

test.beforeEach(async () => {
  handle = await launchKanbini()
})
test.afterEach(async () => {
  await handle?.cleanup()
})

// Open the Welcome Board → a seeded (description-less) card → put the
// description into edit mode with the contenteditable focused. Mirrors
// the TipTap focus-race guard in happy-path.spec.ts.
async function openDescriptionEditor(
  page: Page
): Promise<{ modal: Locator; section: Locator }> {
  await page.getByText('Welcome Board', { exact: true }).click()
  await expect(page.getByRole('heading', { name: /^To Do\b/ })).toBeVisible()
  await page.getByText('Drag a card to another list', { exact: true }).click()
  const modal = page.getByRole('dialog', {
    name: 'Drag a card to another list'
  })
  await expect(modal).toBeVisible()
  await modal.getByText('Add a description…').click()
  const section = modal.locator('section', { hasText: 'Description' })
  await section.locator('.tiptap[contenteditable="true"]').click()
  return { modal, section }
}

test('toolbar Link button inserts a link via the Popover URL input', async () => {
  const { page } = handle
  const { section } = await openDescriptionEditor(page)
  const editor = section.locator('.tiptap[contenteditable="true"]')

  // Type the anchor text + select it.
  await page.keyboard.type('kanbini site', { delay: 15 })
  await page.keyboard.press('Control+a')

  // Open the Link popover (NOT window.prompt), enter a URL, Apply.
  await section.getByRole('button', { name: 'Link', exact: true }).click()
  const urlInput = page.getByLabel('Link URL')
  await expect(urlInput).toBeVisible()
  await urlInput.fill('https://kanbini.example')
  await page.getByRole('button', { name: 'Apply' }).click()

  // The selected text became an <a href> - proof the real Electron path
  // works end-to-end (window.prompt would have returned null → no-op).
  await expect(
    editor.locator('a[href="https://kanbini.example"]')
  ).toHaveText('kanbini site')
})

test('Escape on the Link popover closes only the popover, not the card detail', async () => {
  const { page } = handle
  const { modal, section } = await openDescriptionEditor(page)

  await section.getByRole('button', { name: 'Link', exact: true }).click()
  const urlInput = page.getByLabel('Link URL')
  await expect(urlInput).toBeVisible()

  await page.keyboard.press('Escape')
  // Popover gone…
  await expect(urlInput).not.toBeVisible()
  // …but the card detail is STILL open and STILL in edit mode (the
  // toolbar's Bold button is present) - the overlay-aware Escape in
  // Modal + MarkdownField stopped one press from closing everything.
  await expect(modal).toBeVisible()
  await expect(section.getByRole('button', { name: /Bold/ })).toBeVisible()
})

test('repeatedly opening/closing the description does not drift the modal scroll', async () => {
  const { page } = handle
  const { modal, section } = await openDescriptionEditor(page)
  const editor = section.locator('.tiptap[contenteditable="true"]')
  const titleInput = modal.locator(
    'input[value="Drag a card to another list"]'
  )
  const dialog = page.getByRole('dialog', {
    name: 'Drag a card to another list'
  })
  const line1 = section.getByText('Description line 1', { exact: true })

  // Give the card a tall description so the modal actually scrolls and
  // its end sits well below the viewport (that's what made opening the
  // editor scroll-to-caret + height/anchoring drift). 40 short paragraphs.
  for (let i = 1; i <= 40; i++) {
    await page.keyboard.type(`Description line ${i}`)
    if (i < 40) await page.keyboard.press('Enter')
  }
  // Typing scrolled to the caret (bottom); bring the top back, then exit
  // edit (outside-click the title).
  await dialog.evaluate((el) => {
    el.scrollTop = 0
  })
  await titleInput.click()
  await expect(editor).toHaveCount(0)

  // Park at a small NON-zero scroll where both the title (to exit) and
  // the first description line (to enter) stay visible - so the loop's
  // clicks always land, and the position is a real value that could drift.
  await dialog.evaluate((el) => {
    el.scrollTop = 60
  })
  expect(
    await dialog.evaluate((el) => el.scrollHeight > el.clientHeight + 50)
  ).toBe(true) // sanity: the modal is tall enough to drift
  const start = await dialog.evaluate((el) => el.scrollTop)
  expect(start).toBe(60)

  const scrollTop = (): Promise<number> =>
    dialog.evaluate((el) => el.scrollTop)

  // Open + close several times. Each open used to nudge the modal's
  // scroll (focus-to-end of the long description + the toolbar's height
  // change + scroll-anchoring), creeping the card upward; it must hold.
  for (let i = 0; i < 4; i++) {
    await line1.click()
    await expect(editor).toBeVisible()
    expect(Math.abs((await scrollTop()) - start)).toBeLessThanOrEqual(4)
    await titleInput.click()
    await expect(editor).toHaveCount(0)
    expect(Math.abs((await scrollTop()) - start)).toBeLessThanOrEqual(4)
  }
})
