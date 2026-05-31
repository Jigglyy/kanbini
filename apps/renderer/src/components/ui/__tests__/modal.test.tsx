import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Modal } from '../modal'

// Tests for the body-portaled Modal primitive. Three contracts:
//   - mount: opens via a portal into <body>, locks body scroll,
//     installs an Escape keydown listener
//   - unmount: restores prior overflow, removes the listener
//   - close paths: backdrop click + Escape; content clicks do NOT close

describe('<Modal>', () => {
  it('renders nothing when closed', () => {
    render(
      <Modal open={false} onClose={vi.fn()}>
        <p>hidden</p>
      </Modal>
    )
    expect(screen.queryByText('hidden')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders children inside a role=dialog portaled to body', () => {
    render(
      <Modal open onClose={vi.fn()} label="Test modal">
        <p>visible</p>
      </Modal>
    )
    const dialog = screen.getByRole('dialog', { name: 'Test modal' })
    expect(dialog).toBeInTheDocument()
    expect(screen.getByText('visible')).toBeInTheDocument()
    // Portal lands the dialog as a direct child of body.
    expect(dialog.parentElement).toBe(document.body)
  })

  it('locks body scroll while open + restores it on close', () => {
    document.body.style.overflow = 'auto'
    const { rerender } = render(
      <Modal open onClose={vi.fn()}>
        <p>open</p>
      </Modal>
    )
    expect(document.body.style.overflow).toBe('hidden')
    rerender(
      <Modal open={false} onClose={vi.fn()}>
        <p>open</p>
      </Modal>
    )
    // Restores whatever overflow was set before mount (here 'auto').
    expect(document.body.style.overflow).toBe('auto')
  })

  it('Escape fires onClose', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose}>
        <p>esc me</p>
      </Modal>
    )
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('clicking the backdrop fires onClose', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose} label="Backdrop test">
        <p>content</p>
      </Modal>
    )
    // The dialog element IS the backdrop (the inner box uses
    // stopPropagation for content clicks).
    await user.click(screen.getByRole('dialog', { name: 'Backdrop test' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('clicking inside the content does NOT fire onClose', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose}>
        <p>do not close me</p>
      </Modal>
    )
    await user.click(screen.getByText('do not close me'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('removes the Escape listener after unmount (no stale handler firing)', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const { rerender } = render(
      <Modal open onClose={onClose}>
        <p>x</p>
      </Modal>
    )
    rerender(
      <Modal open={false} onClose={onClose}>
        <p>x</p>
      </Modal>
    )
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
  })

  // Nested-modal Escape stack - only the topmost modal closes on
  // Escape, the underlying one stays put. Without this guard
  // (e.g. the URL cover picker on top of the card detail modal),
  // both fire their onClose on a single press because each
  // installs its own document-level keydown listener.
  it('Escape closes ONLY the topmost when two modals are stacked', async () => {
    const user = userEvent.setup()
    const closeOuter = vi.fn()
    const closeInner = vi.fn()
    render(
      <>
        <Modal open onClose={closeOuter} label="Outer">
          <p>outer body</p>
        </Modal>
        <Modal open onClose={closeInner} label="Inner">
          <p>inner body</p>
        </Modal>
      </>
    )
    await user.keyboard('{Escape}')
    expect(closeInner).toHaveBeenCalledTimes(1)
    expect(closeOuter).not.toHaveBeenCalled()
  })

  it('Escape is swallowed while a [data-overlay] (popover) is open over the modal', async () => {
    // Regression (ADR-0058): the Markdown editor's Link control is a
    // Popover (data-overlay) portaled to <body> on top of the card-detail
    // modal. The first Escape must close that popover, NOT the modal
    // underneath it.
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose} label="Card detail">
        <p>body</p>
        {/* Stand-in for the portaled popover panel. */}
        <div data-overlay="popover">link input</div>
      </Modal>
    )
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Escape closes the outer once the inner is gone', async () => {
    const user = userEvent.setup()
    const closeOuter = vi.fn()
    const closeInner = vi.fn()
    const { rerender } = render(
      <>
        <Modal open onClose={closeOuter} label="Outer">
          <p>outer</p>
        </Modal>
        <Modal open onClose={closeInner} label="Inner">
          <p>inner</p>
        </Modal>
      </>
    )
    // Inner unmounts (e.g. its onClose flipped its open state).
    rerender(
      <>
        <Modal open onClose={closeOuter} label="Outer">
          <p>outer</p>
        </Modal>
        <Modal open={false} onClose={closeInner} label="Inner">
          <p>inner</p>
        </Modal>
      </>
    )
    // Now the outer is on top; Escape should reach it.
    await user.keyboard('{Escape}')
    expect(closeOuter).toHaveBeenCalledTimes(1)
    expect(closeInner).not.toHaveBeenCalled()
  })
})
