import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BulkCardMenu, SelectionBar, type BulkActions } from '../selection'

// SelectionBar (floating bulk-action bar) + BulkCardMenu (the same
// actions on a selected card's right-click). The selection-set maths
// lives in lib/__tests__/card-selection.test.ts; here we check the
// surfaces render the count + wire each action to its callback.

function makeActions(over: Partial<BulkActions> = {}): BulkActions {
  return {
    count: 3,
    allComplete: false,
    labels: [{ id: 'L1', name: 'Bug', color: 'oklch(0.6 0.2 20)' }],
    labelPresence: () => 'none',
    lists: [{ id: 'list-2', name: 'Doing' }],
    onToggleComplete: vi.fn(),
    onSetPriority: vi.fn(),
    onToggleLabel: vi.fn(),
    onMoveTo: vi.fn(),
    onDelete: vi.fn(),
    onClear: vi.fn(),
    ...over
  }
}

describe('<SelectionBar>', () => {
  it('renders nothing when no cards are selected', () => {
    const { container } = render(
      <SelectionBar actions={makeActions({ count: 0 })} />
    )
    expect(container.firstChild).toBeNull()
    expect(screen.queryByText(/selected/)).toBeNull()
  })

  it('shows the count and the action buttons when a selection exists', () => {
    const { baseElement } = render(<SelectionBar actions={makeActions()} />)
    expect(screen.getByText('3 selected')).toBeInTheDocument()
    // Regression: the bar is portaled to <body>, outside the root's
    // `text-foreground`, so it must set its own theme text colour or
    // "N selected" inherits the browser default (black) and is unreadable
    // on the dark card.
    const bar = baseElement.querySelector('[data-overlay="selection-bar"]')
    expect(bar?.className).toContain('text-foreground')
    expect(screen.getByRole('button', { name: /complete/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /priority/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /labels/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /move/i })).toBeInTheDocument()
  })

  it('Complete fires onToggleComplete', async () => {
    const user = userEvent.setup()
    const actions = makeActions()
    render(<SelectionBar actions={actions} />)
    await user.click(screen.getByRole('button', { name: /^complete$/i }))
    expect(actions.onToggleComplete).toHaveBeenCalledTimes(1)
  })

  it('Delete asks for confirmation before firing onDelete', async () => {
    const user = userEvent.setup()
    const actions = makeActions()
    render(<SelectionBar actions={actions} />)
    await user.click(screen.getByRole('button', { name: /^delete$/i }))
    // not yet - a confirm row appears
    expect(actions.onDelete).not.toHaveBeenCalled()
    expect(screen.getByText('Delete 3?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^delete$/i }))
    expect(actions.onDelete).toHaveBeenCalledTimes(1)
  })

  it('Clear fires onClear', async () => {
    const user = userEvent.setup()
    const actions = makeActions()
    render(<SelectionBar actions={actions} />)
    await user.click(screen.getByRole('button', { name: /clear/i }))
    expect(actions.onClear).toHaveBeenCalledTimes(1)
  })

  it('shows the priority options inside the Priority popover', async () => {
    const user = userEvent.setup()
    const actions = makeActions()
    render(<SelectionBar actions={actions} />)
    await user.click(screen.getByRole('button', { name: /priority/i }))
    await user.click(screen.getByRole('button', { name: 'Urgent' }))
    expect(actions.onSetPriority).toHaveBeenCalledWith('urgent')
  })
})

describe('<BulkCardMenu>', () => {
  it('lists the selection count + actions and closes after acting', async () => {
    const user = userEvent.setup()
    const actions = makeActions()
    const close = vi.fn()
    render(<BulkCardMenu actions={actions} close={close} />)
    expect(screen.getByText('3 cards selected')).toBeInTheDocument()

    await user.click(screen.getByText('Mark complete'))
    expect(actions.onToggleComplete).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('moves the selection to a chosen list', async () => {
    const user = userEvent.setup()
    const actions = makeActions()
    render(<BulkCardMenu actions={actions} close={vi.fn()} />)
    await user.click(screen.getByText('Doing'))
    expect(actions.onMoveTo).toHaveBeenCalledWith('list-2')
  })

  it('toggling a label keeps the menu open (no close)', async () => {
    const user = userEvent.setup()
    const actions = makeActions()
    const close = vi.fn()
    render(<BulkCardMenu actions={actions} close={close} />)
    await user.click(screen.getByText('Bug'))
    expect(actions.onToggleLabel).toHaveBeenCalledWith('L1')
    expect(close).not.toHaveBeenCalled()
  })
})
