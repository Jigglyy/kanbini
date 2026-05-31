import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BoardBackground, Mutation } from '@kanbini/shared'
import { ACCENTS, GRADIENT_PRESETS } from '../../lib/palette'
import { BackgroundPicker } from '../background-picker'
import { kanbiniMock } from '../../__tests__/_kanbini-mock'

// Tests for the ADR-0034 background picker. Three tabs (Color /
// Gradient / Image) inside one modal. The picker is decoupled from
// the optimistic cache via the `apply` callback - every test asserts
// against that callback's invocation rather than against a query
// cache.

type ApplyArg = Extract<Mutation, { type: 'board.update' }>
type Apply = (m: ApplyArg) => void

describe('<BackgroundPicker>', () => {
  it('lands on the Color tab when value is null (default)', () => {
    render(
      <BackgroundPicker
        open
        boardId="b1"
        value={null}
        apply={vi.fn<Apply>()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByRole('tab', { name: /Color/ })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    // Color-tab content (Presets header) is visible.
    expect(screen.getByText('Presets')).toBeInTheDocument()
  })

  it('lands on the Gradient tab when value.kind === gradient', () => {
    render(
      <BackgroundPicker
        open
        boardId="b1"
        value={{ kind: 'gradient', preset: 'sunset' }}
        apply={vi.fn<Apply>()}
        onClose={vi.fn()}
      />
    )
    expect(
      screen.getByRole('tab', { name: /Gradient/ })
    ).toHaveAttribute('aria-selected', 'true')
  })

  it('lands on the Image tab when value.kind === image', () => {
    render(
      <BackgroundPicker
        open
        boardId="b1"
        value={{ kind: 'image', relPath: 'board-backgrounds/b1/x.png' }}
        apply={vi.fn<Apply>()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByRole('tab', { name: /Image/ })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  it('switches tabs on click', async () => {
    const user = userEvent.setup()
    render(
      <BackgroundPicker
        open
        boardId="b1"
        value={null}
        apply={vi.fn<Apply>()}
        onClose={vi.fn()}
      />
    )
    await user.click(screen.getByRole('tab', { name: /Gradient/ }))
    expect(
      screen.getByRole('tab', { name: /Gradient/ })
    ).toHaveAttribute('aria-selected', 'true')
    // Gradient tab renders the GRADIENT_PRESETS buttons.
    expect(
      screen.getByRole('button', { name: /Pick Sunset gradient/ })
    ).toBeInTheDocument()
  })

  it('clicking a Color preset fires board.update + closes the modal', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<Apply>()
    const onClose = vi.fn()
    render(
      <BackgroundPicker
        open
        boardId="b1"
        value={null}
        apply={apply}
        onClose={onClose}
      />
    )
    // First accent is blue.
    await user.click(screen.getByRole('button', { name: `Pick ${ACCENTS[0]}` }))
    expect(apply).toHaveBeenCalledWith({
      type: 'board.update',
      id: 'b1',
      patch: { background: { kind: 'color', value: ACCENTS[0] } }
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Custom color → Apply fires the typed value (trimmed)', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<Apply>()
    render(
      <BackgroundPicker
        open
        boardId="b1"
        value={null}
        apply={apply}
        onClose={vi.fn()}
      />
    )
    const textInput = screen.getByPlaceholderText(/oklch/)
    await user.clear(textInput)
    await user.type(textInput, '  oklch(0.5 0.1 200)  ')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(apply).toHaveBeenCalledWith({
      type: 'board.update',
      id: 'b1',
      patch: {
        background: { kind: 'color', value: 'oklch(0.5 0.1 200)' }
      }
    })
  })

  it('Apply is disabled when the custom field is empty', async () => {
    const user = userEvent.setup()
    render(
      <BackgroundPicker
        open
        boardId="b1"
        value={null}
        apply={vi.fn<Apply>()}
        onClose={vi.fn()}
      />
    )
    const textInput = screen.getByPlaceholderText(/oklch/)
    await user.clear(textInput)
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
  })

  it('clicking a Gradient preset fires board.update with the preset key', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<Apply>()
    render(
      <BackgroundPicker
        open
        boardId="b1"
        value={null}
        apply={apply}
        onClose={vi.fn()}
      />
    )
    await user.click(screen.getByRole('tab', { name: /Gradient/ }))
    const ocean = GRADIENT_PRESETS.find((g) => g.key === 'ocean')!
    await user.click(
      screen.getByRole('button', { name: `Pick ${ocean.label} gradient` })
    )
    expect(apply).toHaveBeenCalledWith({
      type: 'board.update',
      id: 'b1',
      patch: { background: { kind: 'gradient', preset: 'ocean' } }
    })
  })

  it('Clear button (visible when a value is set) fires board.update with null', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<Apply>()
    const current: BoardBackground = { kind: 'color', value: ACCENTS[0] }
    render(
      <BackgroundPicker
        open
        boardId="b1"
        value={current}
        apply={apply}
        onClose={vi.fn()}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Clear' }))
    expect(apply).toHaveBeenCalledWith({
      type: 'board.update',
      id: 'b1',
      patch: { background: null }
    })
  })

  it('Clear button is hidden when value is null', () => {
    render(
      <BackgroundPicker
        open
        boardId="b1"
        value={null}
        apply={vi.fn<Apply>()}
        onClose={vi.fn()}
      />
    )
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
  })

  it('Image tab "Choose image" calls boardSetBackgroundImage + closes on a non-null result', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const mock = kanbiniMock()
    mock.boardSetBackgroundImage.mockResolvedValueOnce({
      kind: 'image',
      relPath: 'board-backgrounds/b1/pic.png'
    })
    render(
      <BackgroundPicker
        open
        boardId="b1"
        value={null}
        apply={vi.fn<Apply>()}
        onClose={onClose}
      />
    )
    await user.click(screen.getByRole('tab', { name: /Image/ }))
    await user.click(screen.getByRole('button', { name: /Choose image/ }))
    await waitFor(() => {
      expect(mock.boardSetBackgroundImage).toHaveBeenCalledWith({
        boardId: 'b1'
      })
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Image tab stays open when the file picker is cancelled (null result)', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const mock = kanbiniMock()
    mock.boardSetBackgroundImage.mockResolvedValueOnce(null)
    render(
      <BackgroundPicker
        open
        boardId="b1"
        value={null}
        apply={vi.fn<Apply>()}
        onClose={onClose}
      />
    )
    await user.click(screen.getByRole('tab', { name: /Image/ }))
    await user.click(screen.getByRole('button', { name: /Choose image/ }))
    await waitFor(() => {
      expect(mock.boardSetBackgroundImage).toHaveBeenCalled()
    })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Image tab surfaces an IPC error inline', async () => {
    const user = userEvent.setup()
    const mock = kanbiniMock()
    mock.boardSetBackgroundImage.mockRejectedValueOnce(
      new Error('disk full')
    )
    render(
      <BackgroundPicker
        open
        boardId="b1"
        value={null}
        apply={vi.fn<Apply>()}
        onClose={vi.fn()}
      />
    )
    await user.click(screen.getByRole('tab', { name: /Image/ }))
    await user.click(screen.getByRole('button', { name: /Choose image/ }))
    expect(await screen.findByText('disk full')).toBeInTheDocument()
  })

  it('Image tab shows "Replace image…" when one is already set', () => {
    render(
      <BackgroundPicker
        open
        boardId="b1"
        value={{ kind: 'image', relPath: 'board-backgrounds/b1/x.png' }}
        apply={vi.fn<Apply>()}
        onClose={vi.fn()}
      />
    )
    // Default tab is image when value is image.
    expect(
      screen.getByRole('button', { name: /Replace image/ })
    ).toBeInTheDocument()
  })

  it('Close (X) button calls onClose', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <BackgroundPicker
        open
        boardId="b1"
        value={null}
        apply={vi.fn<Apply>()}
        onClose={onClose}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
