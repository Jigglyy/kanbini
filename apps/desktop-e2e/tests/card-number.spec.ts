import { expect, test } from '@playwright/test'
import { launchKanbini, type E2EHandle } from './_launch.js'
import { mutate, rpc, waitForDiscovery } from './_channel.js'

// Card numbers in the real app: every card shows its #N at the end of
// its meta row, the card detail shows it with a copy button, Settings ->
// Cards -> "Show card numbers" hides it on the board (the detail keeps
// it), and the command palette finds a card by typing its #N.

interface BoardView {
  lists: Array<{ id: string }>
}

let handle: E2EHandle | undefined

test.afterEach(async () => {
  await handle?.cleanup()
})

test('cards show their #number, the setting hides it, and the palette finds it', async () => {
  handle = await launchKanbini()
  const { page, userDataDir } = handle
  const d = await waitForDiscovery(userDataDir)
  const view = await rpc<BoardView>(d, 'board.getView', {})
  const listId = view.lists[0]!.id
  const id = await mutate(d, { type: 'card.create', listId, title: 'Fix login redirect' })
  const { number } = await rpc<{ number: number }>(d, 'card.get', { id })
  expect(number).toBeGreaterThan(0)
  const tag = `#${number}`

  await page.getByText('Welcome Board', { exact: true }).click()
  const card = page.locator(`[data-card-id="${id}"]`)
  await expect(card).toContainText(tag)

  // The detail header shows it too, as a copy button.
  await card.getByText('Fix login redirect').click()
  const detail = page.getByRole('dialog', { name: 'Fix login redirect' })
  await expect(detail.getByRole('button', { name: `Copy card number ${tag}` })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(detail).not.toBeVisible()

  // Turn it off: gone from the board card.
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Cards' }).click()
  await page.getByRole('checkbox', { name: /show card numbers/i }).uncheck()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(card).toBeVisible()
  await expect(card).not.toContainText(tag)

  // The palette still finds it by number; picking the hit points the
  // card out on the board, and Enter then opens it.
  await page.getByRole('button', { name: 'Search' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByPlaceholder(/search cards or jump/i).fill(tag)
  const hit = palette.getByText('Fix login redirect')
  await expect(hit).toBeVisible()
  await expect(palette).toContainText(tag)
  await hit.click()
  await expect(palette).not.toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Fix login redirect' })).toBeVisible()
})
