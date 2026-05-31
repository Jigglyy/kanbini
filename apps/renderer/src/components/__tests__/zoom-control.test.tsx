import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ZoomControl } from '../zoom-control'

// Tests for the ADR-0033 board-zoom slider. Two surfaces:
//   1. The header chip - shows the current pct + opens the popover
//   2. The popover body - slider with the snap-to-100 detent + Reset

describe('<ZoomControl>', () => {
  it('chip shows the rounded percentage from the current value', () => {
    render(<ZoomControl value={1.25} onChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Zoom' })).toHaveTextContent(
      '125%'
    )
  })

  it('rounds non-step values for display (1.234 → 123%)', () => {
    render(<ZoomControl value={1.234} onChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Zoom' })).toHaveTextContent(
      '123%'
    )
  })

  it('opens the popover when the chip is clicked', async () => {
    const user = userEvent.setup()
    render(<ZoomControl value={1} onChange={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Zoom' }))
    expect(screen.getByRole('slider', { name: 'Board zoom' })).toBeInTheDocument()
  })

  it('slider drag fires onChange with the new value', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn<(v: number) => void>()
    render(<ZoomControl value={1} onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: 'Zoom' }))
    const slider = screen.getByRole('slider', { name: 'Board zoom' })
    // Set the range input to 150 → onChange should fire with 1.5.
    fireEvent.change(slider, { target: { value: '150' } })
    expect(onChange).toHaveBeenLastCalledWith(1.5)
  })

  it('snaps to exactly 1.0 inside the soft detent (±0.04)', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn<(v: number) => void>()
    render(<ZoomControl value={1} onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: 'Zoom' }))
    const slider = screen.getByRole('slider', { name: 'Board zoom' })
    // 103% would be 1.03 raw → inside detent → snapped to 1.
    fireEvent.change(slider, { target: { value: '103' } })
    expect(onChange).toHaveBeenLastCalledWith(1)
    // 97% would be 0.97 raw → inside ±0.04 → snapped to 1. (Using
    // 96% trips the floating-point edge - Math.abs(0.96 - 1) is
    // 0.04000000000000003, just over the radius.)
    fireEvent.change(slider, { target: { value: '97' } })
    expect(onChange).toHaveBeenLastCalledWith(1)
  })

  it('does NOT snap outside the detent radius', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn<(v: number) => void>()
    render(<ZoomControl value={1} onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: 'Zoom' }))
    const slider = screen.getByRole('slider', { name: 'Board zoom' })
    // 110% = 1.10 raw → outside ±0.04 → no snap.
    fireEvent.change(slider, { target: { value: '110' } })
    expect(onChange).toHaveBeenLastCalledWith(1.1)
  })

  it('Reset button calls onChange(1) and closes the popover', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn<(v: number) => void>()
    render(<ZoomControl value={1.5} onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: 'Zoom' }))
    await user.click(screen.getByRole('button', { name: /Reset to 100%/ }))
    expect(onChange).toHaveBeenCalledWith(1)
    // Popover should have closed - slider unmounts.
    expect(
      screen.queryByRole('slider', { name: 'Board zoom' })
    ).toBeNull()
  })

  it('Reset is disabled at exactly 100% (no-op state)', async () => {
    const user = userEvent.setup()
    render(<ZoomControl value={1} onChange={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Zoom' }))
    expect(
      screen.getByRole('button', { name: /Reset to 100%/ })
    ).toBeDisabled()
  })

  it('slider min/max/step expose the ZOOM_MIN/MAX/STEP constants', async () => {
    const user = userEvent.setup()
    render(<ZoomControl value={1} onChange={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Zoom' }))
    const slider = screen.getByRole('slider', { name: 'Board zoom' })
    expect(slider).toHaveAttribute('min', '50')
    expect(slider).toHaveAttribute('max', '200')
    expect(slider).toHaveAttribute('step', '5')
  })

  it('value labels show the min / 100 / max marks', async () => {
    const user = userEvent.setup()
    render(<ZoomControl value={1} onChange={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Zoom' }))
    expect(screen.getByText('50%')).toBeInTheDocument()
    expect(screen.getByText('200%')).toBeInTheDocument()
    // "100%" appears in the value chip + the mid label. Both should
    // be in the document - just assert at least one.
    expect(screen.getAllByText('100%').length).toBeGreaterThan(0)
  })
})
