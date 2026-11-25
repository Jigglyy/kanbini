import { expect, test } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchKanbini, type E2EHandle } from './_launch.js'
import { mutate, waitForDiscovery, type Discovery } from './_channel.js'

// A long checklist item does not reflow when it enters edit mode (it used to
// collapse into a one-line input), and a plain click on the text does not
// start an edit.

const LONG =
  'Rewrite the import step so that it reads the export file in chunks, validates every row against the shared schema, ' +
  'reports the first ten failures with their line numbers, and leaves the board untouched when anything fails, ' +
  'then add a regression test that feeds it a truncated file and checks that nothing was written.'

let handle: E2EHandle
let d: Discovery

test.beforeEach(async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'kanbini-e2e-clitem-'))
  handle = await launchKanbini({ userDataDir })
  d = await waitForDiscovery(userDataDir)
  const boardId = await mutate(d, { type: 'board.create', name: 'Garden' })
  const listId = await mutate(d, { type: 'list.create', boardId, name: 'To do' })
  const card = await mutate(d, { type: 'card.create', listId, title: 'Plant bulbs' })
  const checklistId = await mutate(d, { type: 'checklist.create', cardId: card, name: 'Steps' })
  await mutate(d, { type: 'checklistItem.create', checklistId, text: LONG })
  await handle.page.getByText('Garden', { exact: true }).click()
  await handle.page.getByText('Plant bulbs', { exact: true }).click()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

test('editing a long item does not reflow it', async () => {
  const { page } = handle
  const row = page.locator('li', { has: page.getByRole('button', { name: 'Delete item' }) })
  const text = row.getByText(LONG)
  const textBox = (await text.boundingBox())!
  const rowRest = (await row.boundingBox())!.height
  expect(textBox.height).toBeGreaterThan(40)

  // A plain click on the text must not open the editor.
  await text.click()
  await expect(row.locator('input, textarea')).toHaveCount(0)

  await row.getByRole('button', { name: 'Edit item' }).click()
  const editor = row.locator('textarea')
  await expect(editor).toBeVisible()
  await expect(editor).toBeFocused()
  const editorBox = (await editor.boundingBox())!
  const rowEditing = (await row.boundingBox())!.height
  const m = await editor.evaluate((el) => {
    const cs = getComputedStyle(el)
    return {
      contentWidth: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
      contentTop: parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop)
    }
  })
  const textTop = textBox.y
  const editorTextTop = editorBox.y + m.contentTop
  console.log(
    `MEASURE textHeight=${textBox.height} editorHeight=${editorBox.height} ` +
      `rowRest=${rowRest} rowEditing=${rowEditing} ` +
      `textWidth=${textBox.width} editorContentWidth=${m.contentWidth} ` +
      `textTop=${textTop} editorTextTop=${editorTextTop}`
  )
  expect(Math.abs(rowEditing - rowRest)).toBeLessThanOrEqual(1)
  expect(Math.abs(m.contentWidth - textBox.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(editorTextTop - textTop)).toBeLessThanOrEqual(1)
})
