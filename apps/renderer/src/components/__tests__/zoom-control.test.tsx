import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  SLIDER_MAX,
  ZoomControl,
  sliderToZoom,
  zoomToSlider
} from '../zoom-control'

// Tests for the ADR-0033 board-zoom slider. Three surfaces:
//   1. The header chip - shows the current pct + opens the popover
//   2. The track mapping - logarithmic, so 50% / 100% / 200% sit at the
//      left end / exact middle / right end (a linear 50..200 track put
//      100% a third of the way along, under no label)
//   3. The popover body - pointer drags (with the snap-to-100 detent),
//      keyboard steps on a clean 5% grid, and Reset

/** Open the popover and return the slider. */
async function openSlider(value: number, onChange = vi.fn<(v: number) => void>()) {
  const user = userEvent.setup()
  render(<ZoomControl value={value} onChange={onChange} />)
  await user.click(screen.getByRole('button', { name: 'Zoom' }))
  return { user, onChange, slider: screen.getByRole('slider', { name: 'Board zoom' }) }
}

/** Simulate a pointer drag landing on the track position for `zoom`. */
const dragTo = (slider: HTMLElement, zoom: number) =>
  fireEvent.change(slider, { target: { value: String(zoomToSlider(zoom)) } })

describe('zoom track mapping', () => {
  it('puts 50% at the left end, 100% exactly in the middle, 200% at the right end', () => {
    expect(zoomToSlider(0.5)).toBe(0)
    expect(zoomToSlider(1)).toBe(SLIDER_MAX / 2)
    expect(zoomToSlider(2)).toBe(SLIDER_MAX)
  })

  it('is symmetric in zoom factor: halving and doubling are equal distances', () => {
    const mid = SLIDER_MAX / 2
    expect(zoomToSlider(1.5) - mid).toBe(mid - zoomToSlider(1 / 1.5))
  })

  it('round-trips every whole percentage back to itself', () => {
    for (let pct = 50; pct <= 200; pct++) {
      expect(Math.round(sliderToZoom(zoomToSlider(pct / 100)) * 100)).toBe(pct)
    }
  })

  it('clamps out-of-range values to the ends', () => {
    expect(zoomToSlider(0.1)).toBe(0)
    expect(zoomToSlider(5)).toBe(SLIDER_MAX)
  })
})

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
    const { slider } = await openSlider(1)
    expect(slider).toBeInTheDocument()
  })

  it('at 100% the thumb sits in the middle of the track, under the 100% label', async () => {
    const { slider } = await openSlider(1)
    expect(slider).toHaveAttribute('min', '0')
    expect(slider).toHaveAttribute('max', String(SLIDER_MAX))
    expect(slider).toHaveValue(String(SLIDER_MAX / 2))
  })

  it('announces the zoom, not the raw track position, to screen readers', async () => {
    const { slider } = await openSlider(1.25)
    expect(slider).toHaveAttribute('aria-valuetext', '125%')
  })

  it('slider drag fires onChange with the new value', async () => {
    const { slider, onChange } = await openSlider(1)
    dragTo(slider, 1.5)
    expect(onChange).toHaveBeenLastCalledWith(1.5)
  })

  it('snaps to exactly 1.0 inside the soft detent (±0.04)', async () => {
    const { slider, onChange } = await openSlider(1.5)
    dragTo(slider, 1.03)
    expect(onChange).toHaveBeenLastCalledWith(1)
    dragTo(slider, 0.97)
    expect(onChange).toHaveBeenLastCalledWith(1)
  })

  it('does NOT snap outside the detent radius', async () => {
    const { slider, onChange } = await openSlider(1)
    dragTo(slider, 1.1)
    expect(onChange).toHaveBeenLastCalledWith(1.1)
  })

  it('arrow keys step by 5% (and get out of the 100% detent)', async () => {
    const { slider, onChange } = await openSlider(1)
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith(1.05)
    fireEvent.keyDown(slider, { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith(0.95)
    fireEvent.keyDown(slider, { key: 'ArrowUp' })
    expect(onChange).toHaveBeenLastCalledWith(1.05)
    fireEvent.keyDown(slider, { key: 'ArrowDown' })
    expect(onChange).toHaveBeenLastCalledWith(0.95)
  })

  it('a key step from an off-grid value lands on the 5% grid', async () => {
    const { slider, onChange } = await openSlider(1.23)
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith(1.25)
    fireEvent.keyDown(slider, { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith(1.2)
  })

  it('Home / End jump to the ends; key steps clamp there', async () => {
    const { slider, onChange } = await openSlider(1)
    fireEvent.keyDown(slider, { key: 'Home' })
    expect(onChange).toHaveBeenLastCalledWith(0.5)
    fireEvent.keyDown(slider, { key: 'End' })
    expect(onChange).toHaveBeenLastCalledWith(2)
  })

  it('a key step at an end stays at the end', async () => {
    const { slider, onChange } = await openSlider(2)
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith(2)
  })

  it('Reset button calls onChange(1) and closes the popover', async () => {
    const { user, onChange } = await openSlider(1.5)
    await user.click(screen.getByRole('button', { name: /Reset to 100%/ }))
    expect(onChange).toHaveBeenCalledWith(1)
    // Popover should have closed - slider unmounts.
    expect(
      screen.queryByRole('slider', { name: 'Board zoom' })
    ).toBeNull()
  })

  it('Reset is disabled at exactly 100% (no-op state)', async () => {
    await openSlider(1)
    expect(
      screen.getByRole('button', { name: /Reset to 100%/ })
    ).toBeDisabled()
  })

  it('value labels show the min / 100 / max marks', async () => {
    await openSlider(1)
    expect(screen.getByText('50%')).toBeInTheDocument()
    expect(screen.getByText('200%')).toBeInTheDocument()
    // "100%" appears in the value chip + the mid label. Both should
    // be in the document - just assert at least one.
    expect(screen.getAllByText('100%').length).toBeGreaterThan(0)
  })
})
