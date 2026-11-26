import { expect, test, type Page } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchKanbini, type E2EHandle } from './_launch.js'
import { mutate, rpc, waitForDiscovery, type Discovery } from './_channel.js'

// E2E for attachments as media (board cards #2, #3, #4): the viewer's
// zoom, video playback (CSP + MIME + byte ranges through kanbini-file://),
// video covers, and files dropped onto an open card. Ctrl+V of files
// copied in Explorer lives in paste-image.spec (it shares the system
// clipboard, so those run one at a time).

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

let handle: E2EHandle
let d: Discovery
let cardId: string

interface CardLite {
  attachments: Array<{ id: string; filename: string; relPath: string }>
  coverAttachmentId: string | null
}

test.beforeEach(async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'kanbini-e2e-media-'))
  handle = await launchKanbini({ userDataDir })
  d = await waitForDiscovery(userDataDir)
  const boardId = await mutate(d, { type: 'board.create', name: 'Media' })
  const listId = await mutate(d, { type: 'list.create', boardId, name: 'Shots' })
  cardId = await mutate(d, { type: 'card.create', listId, title: 'Trailer' })
  await handle.page.getByText('Media', { exact: true }).click()
})

test.afterEach(async () => {
  await handle?.cleanup()
})

const stored = (): Promise<CardLite> => rpc<CardLite>(d, 'card.get', { id: cardId })
const attach = (file: string): Promise<unknown> =>
  rpc(d, 'attachment.add', { cardId, path: join(FIXTURES, file) })

async function openCard(page: Page) {
  await page.getByText('Trailer', { exact: true }).click()
  const detail = page.getByRole('dialog', { name: 'Trailer' })
  await expect(detail).toBeVisible()
  return detail
}

test('the image viewer zooms, keeps pixels sharp, and keeps Escape to itself', async () => {
  const { page } = handle
  await attach('big.png')
  const detail = await openCard(page)
  await detail.getByRole('button', { name: 'Preview image' }).click()
  const viewer = page.getByRole('dialog', { name: 'big.png' })
  await expect(viewer).toBeVisible()
  await expect(viewer.getByText(/1200 × 900/)).toBeVisible()
  const pct = viewer.getByRole('button', { name: 'Actual size' })
  await expect(pct).toHaveText(/%$/)
  const fit = parseInt((await pct.textContent())!, 10)
  expect(fit).toBeLessThan(100)

  // The wheel zooms in toward the cursor.
  const stage = viewer.getByTestId('media-stage')
  const box = (await stage.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, -400)
  await expect.poll(async () => parseInt((await pct.textContent())!, 10)).toBeGreaterThan(fit)

  // Past 100% the pixels stay sharp.
  await page.keyboard.press('1')
  await expect(pct).toHaveText('100%')
  await page.keyboard.press('+')
  const img = viewer.getByAltText('big.png')
  await expect.poll(() => img.evaluate((el) => (el as HTMLElement).style.imageRendering)).toBe(
    'pixelated'
  )
  await page.keyboard.press('0')
  await expect(pct).toHaveText(`${fit}%`)

  // Escape closes the viewer, not the card under it.
  await page.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)
  await expect(detail).toBeVisible()
})

test('a video plays in the viewer, served in byte ranges', async () => {
  const { page } = handle
  await attach('tiny.mp4')
  const detail = await openCard(page)
  await detail.getByRole('button', { name: 'Play video' }).click()
  const viewer = page.getByRole('dialog', { name: 'tiny.mp4' })
  const video = viewer.locator('video')
  // Metadata loaded = allowed by the CSP, typed as video, and decodable.
  await expect.poll(() => video.evaluate((v) => (v as HTMLVideoElement).videoWidth)).toBe(64)
  await expect(viewer.getByText(/64 × 48/)).toBeVisible()

  const src = (await video.getAttribute('src'))!
  const ranged = await page.evaluate(async (url) => {
    const r = await fetch(url, { headers: { Range: 'bytes=0-9' } })
    return { status: r.status, range: r.headers.get('content-range'), bytes: (await r.arrayBuffer()).byteLength }
  }, src)
  expect(ranged.status).toBe(206)
  expect(ranged.range).toMatch(/^bytes 0-9\/\d+$/)
  expect(ranged.bytes).toBe(10)
})

test('a video cover is a still frame on the board and plays in the card', async () => {
  const { page } = handle
  await attach('tiny.mp4')
  const detail = await openCard(page)
  // The row's buttons only fade in on hover; Playwright clicks them anyway.
  await detail.getByRole('button', { name: 'Make cover' }).click()
  await expect.poll(async () => (await stored()).coverAttachmentId).not.toBeNull()
  await expect(detail.getByLabel('tiny.mp4', { exact: true })).toHaveAttribute('controls', '')
  await page.keyboard.press('Escape')
  const still = page.locator('[data-card-id] video')
  await expect(still).toHaveCount(1)
  expect(await still.getAttribute('controls')).toBeNull()
})

test('a file dropped onto the open card is attached', async () => {
  const { page } = handle
  const detail = await openCard(page)
  // A real OS drag can't be scripted; a File picked through an <input>
  // carries its path like a dropped one does, so drop that.
  await page.evaluate(() => {
    const input = Object.assign(document.createElement('input'), { type: 'file', id: 'e2e-drop' })
    input.style.display = 'none'
    document.body.append(input)
  })
  await page.setInputFiles('#e2e-drop', join(FIXTURES, 'big.png'))
  await detail.evaluate((el) => {
    const file = (document.getElementById('e2e-drop') as HTMLInputElement).files![0]!
    const dt = new DataTransfer()
    dt.items.add(file)
    const target = el.querySelector('h3') ?? el
    for (const type of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }))
    }
  })
  await expect.poll(async () => (await stored()).attachments.map((a) => a.filename)).toEqual([
    'big.png'
  ])
  await expect(detail.getByRole('button', { name: 'Preview image' })).toBeVisible()
})
