import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ImageLightbox } from '../lightbox'
import { Modal } from '../modal'

// Tests for the full-viewport ImageLightbox. The load-bearing contract
// is the Escape behaviour: the lightbox is opened from INSIDE a
// CardDetail Modal (cover image / attachment thumbnail), so it must
// join the Modal escape-stack - a single Escape closes only the
// lightbox, never the modal underneath it.

describe('<ImageLightbox>', () => {
  it('renders the image in a body-portalled role=dialog', () => {
    render(<ImageLightbox src="kanbini-file://x.png" alt="cover" onClose={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: 'cover' })
    expect(dialog.parentElement).toBe(document.body)
    expect(screen.getByAltText('cover')).toBeInTheDocument()
  })

  it('Escape closes the lightbox', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<ImageLightbox src="x" alt="img" onClose={onClose} />)
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('clicking the backdrop closes; clicking the image does not', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<ImageLightbox src="x" alt="img" onClose={onClose} />)
    await user.click(screen.getByRole('dialog', { name: 'img' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    onClose.mockClear()
    await user.click(screen.getByAltText('img'))
    expect(onClose).not.toHaveBeenCalled()
  })

  // Regression: before joining the escape-stack, the lightbox's own
  // bare keydown listener AND the underlying Modal's both fired on one
  // Escape, so dismissing the enlarged image also closed the card
  // detail (a two-level close from a single press).
  it('Escape closes ONLY the lightbox when stacked on a Modal', async () => {
    const user = userEvent.setup()
    const closeModal = vi.fn()
    const closeLightbox = vi.fn()
    render(
      <Modal open onClose={closeModal} label="Card detail">
        <p>card body</p>
        <ImageLightbox src="x" alt="enlarged" onClose={closeLightbox} />
      </Modal>
    )
    await user.keyboard('{Escape}')
    expect(closeLightbox).toHaveBeenCalledTimes(1)
    expect(closeModal).not.toHaveBeenCalled()
  })

  it('once the lightbox is gone, Escape reaches the Modal again', async () => {
    const user = userEvent.setup()
    const closeModal = vi.fn()
    const closeLightbox = vi.fn()
    const { rerender } = render(
      <Modal open onClose={closeModal} label="Card detail">
        <p>card body</p>
        <ImageLightbox src="x" alt="enlarged" onClose={closeLightbox} />
      </Modal>
    )
    // Lightbox unmounts (its onClose flipped the host's open state).
    rerender(
      <Modal open onClose={closeModal} label="Card detail">
        <p>card body</p>
      </Modal>
    )
    await user.keyboard('{Escape}')
    expect(closeModal).toHaveBeenCalledTimes(1)
    expect(closeLightbox).not.toHaveBeenCalled()
  })
})
