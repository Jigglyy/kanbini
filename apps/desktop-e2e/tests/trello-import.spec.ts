import { expect, test } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchKanbini, type E2EHandle } from './_launch.js'

// E2E for the ADR-0028 Trello import on boards-home. Drives the
// full chain: native file-picker (overridden via
// KANBINI_E2E_DIALOG_FILE) → zTrelloBoard validation in main →
// importFromTrello in @kanbini/db → broadcastChange → renderer
// navigates to the new board.
//
// Fixture is the smallest realistic Trello shape: 3 lists, 2 cards,
// 1 used label (+ 1 unused that the importer drops), 1 checklist
// with 2 items, 0 attachments (Trello attachments are URLs we
// don't follow - counted as skipped).

let handle: E2EHandle

const TRELLO_FIXTURE = {
  id: 'trello-1',
  name: 'Imported from Trello',
  desc: '',
  lists: [
    { id: 'L-1', name: 'Backlog', pos: 100 },
    { id: 'L-2', name: 'Active', pos: 200 },
    { id: 'L-3', name: 'Shipped', pos: 300 }
  ],
  labels: [
    { id: 'lab-bug', name: 'bug', color: 'red' },
    { id: 'lab-dropped', name: 'dropped', color: 'blue' }
  ],
  cards: [
    {
      id: 'C-1',
      name: 'Plan the launch',
      desc: 'Outline + dates',
      idList: 'L-1',
      idLabels: ['lab-bug'],
      due: null,
      dueComplete: false,
      pos: 100,
      attachments: []
    },
    {
      id: 'C-2',
      name: 'Ship v0',
      desc: '',
      idList: 'L-3',
      idLabels: [],
      due: null,
      dueComplete: false,
      pos: 200,
      attachments: []
    }
  ],
  checklists: [
    {
      id: 'CL-1',
      idCard: 'C-1',
      name: 'Pre-flight',
      pos: 1,
      checkItems: [
        { id: 'I-1', name: 'staging green', state: 'complete', pos: 1 },
        { id: 'I-2', name: 'changelog ready', state: 'incomplete', pos: 2 }
      ]
    }
  ]
}

test.afterEach(async () => {
  await handle?.cleanup()
})

test('Trello JSON import creates a new board + jumps into it', async () => {
  // Write the fixture to a temp file the (overridden) file dialog
  // will return.
  const tmp = await mkdtemp(join(tmpdir(), 'kanbini-e2e-trello-'))
  const fixturePath = join(tmp, 'trello-export.json')
  await writeFile(fixturePath, JSON.stringify(TRELLO_FIXTURE))

  handle = await launchKanbini({
    env: { KANBINI_E2E_DIALOG_FILE: fixturePath }
  })
  const { page } = handle

  // Boards-home shows the seeded Welcome Board. Click Import from
  // Trello → the dialog (overridden to return fixturePath) → main
  // parses + creates the new board + broadcasts → boards-home's
  // runTrelloImport navigates to it via onOpen(summary.boardId).
  await expect(
    page.getByRole('heading', { name: 'Welcome Board', exact: true })
  ).toBeVisible()
  await page
    .getByRole('button', { name: /import from trello/i })
    .click()

  // We've navigated into the new "Imported from Trello" board view.
  // Header crumb shows the board name; the three lists from the
  // fixture render.
  await expect(
    page.getByText('Imported from Trello', { exact: true })
  ).toBeVisible({ timeout: 15_000 })
  await expect(
    page.getByRole('heading', { name: /^Backlog\b/ })
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: /^Active\b/ })
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: /^Shipped\b/ })
  ).toBeVisible()

  // Cards landed in the right lists.
  await expect(
    page.getByText('Plan the launch', { exact: true })
  ).toBeVisible()
  await expect(page.getByText('Ship v0', { exact: true })).toBeVisible()
})
