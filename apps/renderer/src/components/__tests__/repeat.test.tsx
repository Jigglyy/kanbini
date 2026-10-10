import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BoardView, CardView } from '@kanbini/shared'
import { RepeatBadge, RepeatPicker, repeatSpan } from '../repeat'

// Repeat marker + card-menu picker. The spawn itself is server-side.

function makeCard(over: Partial<CardView> = {}): CardView {
  return {
    id: 'c1',
    number: 1,
    title: 'Water the plants',
    description: null,
    position: 'a',
    completed: false,
    dueAt: null,
    priority: null,
    repeat: null,
    collapsed: null,
    labelIds: [],
    checklists: [],
    comments: [],
    attachments: [],
    coverAttachmentId: null,
    activities: [],
    blockedBy: [],
    blocking: [],
    ...over
  }
}

function renderPicker(card: CardView) {
  const apply = vi.fn()
  const close = vi.fn()
  render(<RepeatPicker card={card} apply={apply} close={close} />)
  return { apply, close }
}

describe('<RepeatBadge>', () => {
  it('renders nothing for a one-off card', () => {
    const { container } = render(<RepeatBadge card={makeCard()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('is an icon with a label on the list card', () => {
    render(<RepeatBadge card={makeCard({ repeat: { unit: 'week', every: 2 } })} />)
    expect(screen.getByRole('img', { name: 'Repeats every 2 weeks' })).toBeInTheDocument()
  })

  it('spells the rule out in the card detail', () => {
    render(<RepeatBadge card={makeCard({ repeat: { unit: 'day', every: 1 } })} withText />)
    expect(screen.getByText('Every day')).toBeInTheDocument()
  })
})

describe('<RepeatPicker>', () => {
  it('marks Off for a one-off card', () => {
    renderPicker(makeCard())
    expect(screen.getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText(/completing it adds/i)).not.toBeInTheDocument()
  })

  it('sets a preset with an optimistic projection', async () => {
    const user = userEvent.setup()
    const { apply, close } = renderPicker(makeCard())
    await user.click(screen.getByRole('button', { name: 'Weekly' }))
    expect(apply).toHaveBeenCalledWith(
      { type: 'card.update', id: 'c1', patch: { repeat: { unit: 'week', every: 1 } } },
      expect.any(Function)
    )
    const project = apply.mock.calls[0]![1] as (b: BoardView) => BoardView
    const board = { lists: [{ cards: [makeCard()] }] } as unknown as BoardView
    expect(project(board).lists[0]!.cards[0]!.repeat).toEqual({ unit: 'week', every: 1 })
    expect(close).toHaveBeenCalled()
  })

  it('turns repeating off', async () => {
    const user = userEvent.setup()
    const { apply } = renderPicker(makeCard({ repeat: { unit: 'month', every: 1 } }))
    expect(screen.getByRole('button', { name: 'Monthly' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(/completing it adds the next one, due a month later/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Off' }))
    expect(apply).toHaveBeenCalledWith(
      { type: 'card.update', id: 'c1', patch: { repeat: null } },
      expect.any(Function)
    )
  })

  it('skips the write when the current choice is clicked again', async () => {
    const user = userEvent.setup()
    const { apply, close } = renderPicker(makeCard({ repeat: { unit: 'week', every: 1 } }))
    await user.click(screen.getByRole('button', { name: 'Weekly' }))
    expect(apply).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
  })

  it('sets a custom rule', async () => {
    const user = userEvent.setup()
    const { apply } = renderPicker(makeCard())
    await user.click(screen.getByRole('button', { name: /custom/i }))
    const every = screen.getByRole('spinbutton', { name: 'Repeat every' })
    await user.clear(every)
    await user.type(every, '3')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Repeat unit' }), 'months')
    await user.click(screen.getByRole('button', { name: 'Set' }))
    expect(apply).toHaveBeenCalledWith(
      { type: 'card.update', id: 'c1', patch: { repeat: { unit: 'month', every: 3 } } },
      expect.any(Function)
    )
  })

  it('refuses an out-of-range custom interval', async () => {
    const user = userEvent.setup()
    renderPicker(makeCard())
    await user.click(screen.getByRole('button', { name: /custom/i }))
    const every = screen.getByRole('spinbutton', { name: 'Repeat every' })
    await user.clear(every)
    await user.type(every, '0')
    expect(screen.getByRole('button', { name: 'Set' })).toBeDisabled()
  })

  it('shows a non-preset rule as the active chip', () => {
    renderPicker(makeCard({ repeat: { unit: 'day', every: 3 } }))
    expect(screen.getByRole('button', { name: 'Every 3 days' })).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('repeatSpan', () => {
  it('reads as a distance', () => {
    expect(repeatSpan({ unit: 'week', every: 1 })).toBe('a week')
    expect(repeatSpan({ unit: 'day', every: 5 })).toBe('5 days')
  })
})
