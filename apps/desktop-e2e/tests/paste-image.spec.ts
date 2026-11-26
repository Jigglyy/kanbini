import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchKanbini, type E2EHandle } from './_launch.js'
import { mutate, rpc, waitForDiscovery } from './_channel.js'

// E2E: Ctrl+V while a card is open attaches the clipboard image.
//
// Drives the full path that can't be exercised in JSDOM: a real image
// on the OS clipboard (written from the Electron main process) → the
// card-detail keydown listener → the attachment:pasteImage IPC → main's
// clipboard.readImage() → a PNG written under userData/attachments →
// createAttachment → broadcastChange → the Attachments list shows the
// new file. A plain text paste (no image) is left untouched, covered by
// the renderer unit test.

let handle: E2EHandle

// Both tests write the real system clipboard: one at a time.
test.describe.configure({ mode: 'serial' })

test.afterEach(async () => {
  await handle?.cleanup()
})

// The clipboard image is built from a raw 8x8 bitmap, NOT decoded from
// PNG bytes. The spec used to call nativeImage.createFromBuffer() on a 1x1
// PNG, and that decode intermittently returned an EMPTY image before any
// app code ran - so the handler correctly saw "no image on the clipboard"
// and the spec failed. createFromBitmap involves no decoder; the handler
// still gets a real image and still writes it out as PNG.
const BITMAP_SIDE = 8

test('Ctrl+V in an open card attaches the clipboard image', async () => {
  handle = await launchKanbini()
  const { page, app } = handle

  // Put a real PNG on the system clipboard via the main process.
  await app.evaluate(({ clipboard, nativeImage }, side) => {
    // BGRA, opaque mid-grey.
    const img = nativeImage.createFromBitmap(Buffer.alloc(side * side * 4, 200), {
      width: side,
      height: side
    })
    if (img.isEmpty()) throw new Error('test fixture image is empty')
    clipboard.writeImage(img)
  }, BITMAP_SIDE)

  await page.getByText('Welcome Board', { exact: true }).click()
  await page
    .getByText('Click the checkbox to complete me', { exact: true })
    .click()
  const detail = page.getByRole('dialog', {
    name: 'Click the checkbox to complete me'
  })
  await expect(detail).toBeVisible()

  // No image attachment yet (each image attachment renders one
  // "Preview image" thumbnail button - an unambiguous per-attachment
  // count, unlike getByText which also matches the row wrapping the
  // filename span).
  const thumbs = detail.getByRole('button', { name: 'Preview image' })
  await expect(thumbs).toHaveCount(0)

  await page.keyboard.press('Control+v')

  // The clipboard image lands as exactly ONE attachment (a single Ctrl+V
  // must not double-attach). 15 s covers full-suite system load; the
  // happy path is well under 1 s.
  await expect(thumbs).toHaveCount(1, { timeout: 15_000 })
  await expect(detail.getByText(/pasted-\d+\.png/).first()).toBeVisible()
})

test('Ctrl+V with files copied in Explorer attaches the files themselves', async () => {
  test.skip(process.platform !== 'win32', 'reads the Windows clipboard file list')
  const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
  const userDataDir = await mkdtemp(join(tmpdir(), 'kanbini-e2e-clip-'))
  handle = await launchKanbini({ userDataDir })
  const { page } = handle
  const d = await waitForDiscovery(userDataDir)
  const boardId = await mutate(d, { type: 'board.create', name: 'Media' })
  const listId = await mutate(d, { type: 'list.create', boardId, name: 'Shots' })
  const cardId = await mutate(d, { type: 'card.create', listId, title: 'Trailer' })

  // A GIF and a video copied in Explorer: they attach as themselves (the
  // GIF keeps its animation), not as a picture of the clipboard.
  const gif = join(userDataDir, 'cat.gif')
  const clip = join(userDataDir, 'clip.mp4')
  await copyFile(join(fixtures, 'big.png'), gif)
  await copyFile(join(fixtures, 'tiny.mp4'), clip)
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-STA',
    '-Command',
    `Set-Clipboard -LiteralPath '${gif}','${clip}'`
  ])

  await page.getByText('Media', { exact: true }).click()
  await page.getByText('Trailer', { exact: true }).click()
  const detail = page.getByRole('dialog', { name: 'Trailer' })
  await detail.getByRole('heading', { name: 'Attachments' }).click()
  await page.keyboard.press('Control+v')
  const names = async (): Promise<string[]> =>
    (await rpc<{ attachments: Array<{ filename: string }> }>(d, 'card.get', { id: cardId })).attachments
      .map((a) => a.filename)
      .sort()
  await expect.poll(names, { timeout: 15_000 }).toEqual(['cat.gif', 'clip.mp4'])
})
