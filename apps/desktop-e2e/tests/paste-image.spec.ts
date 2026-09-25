import { expect, test } from '@playwright/test'
import { launchKanbini, type E2EHandle } from './_launch.js'

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
