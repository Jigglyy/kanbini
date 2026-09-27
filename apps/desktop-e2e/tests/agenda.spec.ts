import { expect, test } from '@playwright/test'
import { launchKanbini, type E2EHandle } from './_launch.js'
import { mutate, rpc, waitForDiscovery } from './_channel.js'

// E2E for the boards-home Agenda. The seeded Welcome Board has no due
// dates and its completed cards have no completion activity, so a fresh
// launch starts with an empty agenda. Due dates are set over the real
// control channel (the same path an AI edit takes), which also proves
// the home screen picks up out-of-band edits live. Then the user
// completes a card from the agenda and opens another from its row.

let handle: E2EHandle

test.beforeEach(async () => {
  handle = await launchKanbini()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

interface BoardView {
  board: { id: string; name: string }
  lists: Array<{ cards: Array<{ id: string; title: string; completed: boolean }> }>
}

/** Local midnight `offset` days from today - how due dates are stored. */
const dayStart = (offset: number): number => {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset).getTime()
}

test('agenda lists due cards live, completes one, and opens another', async () => {
  const { page, userDataDir } = handle
  const agenda = page.getByRole('region', { name: 'Agenda' })
  await expect(agenda).toBeVisible()
  await expect(agenda.getByText(/nothing due in the next 7 days/i)).toBeVisible()

  const d = await waitForDiscovery(userDataDir)
  const view = await rpc<BoardView>(d, 'board.getView', {})
  const open = view.lists.flatMap((l) => l.cards).filter((c) => !c.completed)
  const [dueToday, overdue] = open
  await mutate(d, { type: 'card.update', id: dueToday!.id, patch: { dueAt: dayStart(0) } })
  await mutate(d, { type: 'card.update', id: overdue!.id, patch: { dueAt: dayStart(-2) } })

  const todayList = agenda.getByRole('list', { name: /due today/i })
  const overdueList = agenda.getByRole('list', { name: /overdue/i })
  await expect(todayList.getByText(dueToday!.title)).toBeVisible()
  await expect(overdueList.getByText(overdue!.title)).toBeVisible()
  await expect(overdueList.getByText('2 days ago')).toBeVisible()
  await expect(agenda.getByRole('button', { name: /^agenda/i })).toContainText(
    '1 overdue'
  )

  // Complete the due-today card from its agenda checkbox.
  await agenda
    .getByRole('checkbox', { name: `Mark "${dueToday!.title}" complete` })
    .click()
  const doneList = agenda.getByRole('list', { name: /recently completed/i })
  await expect(doneList.getByText(dueToday!.title)).toBeVisible()
  await expect(agenda.getByText('Nothing due today')).toBeVisible()

  // The REST alias reads the same agenda the panel shows.
  const res = await fetch(`http://127.0.0.1:${d.port}/agenda?upcomingDays=3`, {
    headers: { Authorization: `Bearer ${d.token}` }
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    upcomingDays: number
    overdue: Array<{ cardId: string }>
    completed: Array<{ cardId: string }>
  }
  expect(body.upcomingDays).toBe(3)
  expect(body.overdue.map((c) => c.cardId)).toEqual([overdue!.id])
  expect(body.completed.map((c) => c.cardId)).toContain(dueToday!.id)

  // Clicking a row opens that card on its board.
  await overdueList.getByRole('button', { name: new RegExp(overdue!.title) }).click()
  await expect(page.getByRole('dialog', { name: overdue!.title })).toBeVisible()
})

test('the agenda collapses to its summary and stays collapsed', async () => {
  const { page } = handle
  const agenda = page.getByRole('region', { name: 'Agenda' })
  const toggle = agenda.getByRole('button', { name: /^agenda/i })
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(agenda.getByText(/nothing due/i)).toHaveCount(0)

  // Round-trip through a board and back: still collapsed.
  await page.getByText('Welcome Board', { exact: true }).click()
  await expect(page.getByRole('heading', { name: /^To Do\b/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
})
