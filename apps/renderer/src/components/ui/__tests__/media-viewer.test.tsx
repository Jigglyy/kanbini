import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MediaViewer, type MediaItem } from '../media-viewer'
import { Modal } from '../modal'

// The media viewer: a card's images and videos, one at a time. Escape
// belongs to it while it's open (it opens from inside the card detail
// Modal), arrows flip through the items, and images zoom.

const items: MediaItem[] = [
  { id: 'a', src: 'x/a.png', name: 'a.png', kind: 'image', size: 2048 },
  { id: 'b', src: 'x/b.mp4', name: 'b.mp4', kind: 'video', size: 5 * 1024 * 1024 },
  { id: 'c', src: 'x/c.png', name: 'c.png', kind: 'image', size: null }
]

// JSDOM lays nothing out: give the stage a size and the image a natural
// size so the zoom maths has something to work with.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
})
afterEach(() => vi.restoreAllMocks())

function loadImage(alt: string, w = 1600, h = 1200): void {
  const img = screen.getByAltText(alt) as HTMLImageElement
  Object.defineProperty(img, 'naturalWidth', { value: w, configurable: true })
  Object.defineProperty(img, 'naturalHeight', { value: h, configurable: true })
  fireEvent.load(img)
}

describe('<MediaViewer>', () => {
  it('shows the item in a body-portaled dialog with its info and position', () => {
    render(<MediaViewer items={items} startIndex={0} onClose={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: 'a.png' })
    expect(dialog.parentElement).toBe(document.body)
    expect(screen.getByText('1 / 3')).toBeInTheDocument()
    loadImage('a.png')
    expect(screen.getByText('1600 × 1200 · 2.0 KB')).toBeInTheDocument()
  })

  it('Next / Previous and the arrow keys step through, wrapping around', async () => {
    const user = userEvent.setup()
    render(<MediaViewer items={items} startIndex={0} onClose={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByRole('dialog', { name: 'b.mp4' })).toBeInTheDocument()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('dialog', { name: 'c.png' })).toBeInTheDocument()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('dialog', { name: 'a.png' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Previous' }))
    expect(screen.getByRole('dialog', { name: 'c.png' })).toBeInTheDocument()
  })

  it('plays a video with controls and offers no zoom', () => {
    const { baseElement } = render(<MediaViewer items={items} startIndex={1} onClose={vi.fn()} />)
    const video = baseElement.querySelector('video')!
    expect(video).toHaveAttribute('controls')
    expect(video.getAttribute('src')).toBe('x/b.mp4')
    expect(screen.queryByRole('button', { name: 'Zoom in' })).toBeNull()
  })

  it('zooms with the buttons and keys, and fits again', async () => {
    const user = userEvent.setup()
    render(<MediaViewer items={items} startIndex={0} onClose={vi.fn()} />)
    loadImage('a.png')
    const pct = screen.getByRole('button', { name: 'Actual size' })
    expect(pct).toHaveTextContent('50%')
    await user.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(pct).toHaveTextContent('63%')
    await user.click(pct)
    expect(pct).toHaveTextContent('100%')
    await user.keyboard('0')
    expect(pct).toHaveTextContent('50%')
    await user.keyboard('-')
    expect(pct).toHaveTextContent('40%')
  })

  it('a click on the empty stage closes; a click on the image does not', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<MediaViewer items={items} startIndex={0} onClose={onClose} />)
    await user.click(screen.getByAltText('a.png'))
    expect(onClose).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('media-stage'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Open in default app passes the item and shows why it failed', async () => {
    const user = userEvent.setup()
    const onOpenInApp = vi.fn().mockResolvedValue('No app for this file.')
    render(<MediaViewer items={items} startIndex={2} onClose={vi.fn()} onOpenInApp={onOpenInApp} />)
    await user.click(screen.getByRole('button', { name: 'Open in default app' }))
    expect(onOpenInApp).toHaveBeenCalledWith('c')
    expect(await screen.findByRole('alert')).toHaveTextContent('No app for this file.')
  })

  it('without a handler there is no Open in default app', () => {
    render(<MediaViewer items={items} startIndex={0} onClose={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Open in default app' })).toBeNull()
  })

  it('Escape closes ONLY the viewer when it sits on a Modal', async () => {
    const user = userEvent.setup()
    const closeModal = vi.fn()
    const closeViewer = vi.fn()
    render(
      <Modal open onClose={closeModal} label="Card detail">
        <p>card body</p>
        <MediaViewer items={items} startIndex={0} onClose={closeViewer} />
      </Modal>
    )
    await user.keyboard('{Escape}')
    expect(closeViewer).toHaveBeenCalledTimes(1)
    expect(closeModal).not.toHaveBeenCalled()
  })

  it('once the viewer is gone, Escape reaches the Modal again', async () => {
    const user = userEvent.setup()
    const closeModal = vi.fn()
    const { rerender } = render(
      <Modal open onClose={closeModal} label="Card detail">
        <MediaViewer items={items} startIndex={0} onClose={vi.fn()} />
      </Modal>
    )
    rerender(
      <Modal open onClose={closeModal} label="Card detail">
        <p>card body</p>
      </Modal>
    )
    await user.keyboard('{Escape}')
    expect(closeModal).toHaveBeenCalledTimes(1)
  })
})
