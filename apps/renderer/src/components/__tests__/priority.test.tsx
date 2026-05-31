import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CardView, Mutation } from '@kanbini/shared'
import {
  PRIORITY_LEVELS,
  PriorityBadge,
  PriorityPicker,
  priorityColor,
  priorityLabel
} from '../priority'

// Component tests for the ADR-0037 priority surface. Two components +
// two pure helpers - all small enough to assert by rendered text +
// click interactions. No QueryClient needed (this surface doesn't
// touch the cache directly; the picker just hands a mutation back
// to its `apply` callback).

function makeCard(
  overrides: Partial<CardView> = {}
): CardView {
  return {
    id: 'c1',
    title: 'Card',
    description: null,
    position: 'a0',
    completed: false,
    dueAt: null,
    priority: null,
    labelIds: [],
    checklists: [],
    comments: [],
    attachments: [],
    coverAttachmentId: null,
    activities: [],
    ...overrides
  }
}

describe('priorityLabel / priorityColor', () => {
  it('labels each known level + falls back to "None" for null', () => {
    expect(priorityLabel(null)).toBe('None')
    expect(priorityLabel(undefined)).toBe('None')
    expect(priorityLabel('low')).toBe('Low')
    expect(priorityLabel('medium')).toBe('Medium')
    expect(priorityLabel('high')).toBe('High')
    expect(priorityLabel('urgent')).toBe('Urgent')
  })

  it('echoes unknown stored values (older build / future kind)', () => {
    // Soft-narrow already happens in the data layer; the helper just
    // returns whatever string is stored so the UI doesn't show "None"
    // for a value the user can see in the DB.
    expect(priorityLabel('critical')).toBe('critical')
  })

  it('returns the same colour for the same level each time', () => {
    // Deterministic palette - important for visual regression /
    // snapshot-style tests in the future. The actual value is
    // documented in `META` inside priority.tsx; here we just confirm
    // it doesn't vary across calls.
    const first = priorityColor('urgent')
    expect(priorityColor('urgent')).toBe(first)
    expect(priorityColor('low')).not.toBe(first)
  })
})

describe('<PriorityBadge>', () => {
  it('renders nothing for an unprioritised card', () => {
    const { container } = render(<PriorityBadge card={makeCard()} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the label + flag for each known priority', () => {
    for (const p of PRIORITY_LEVELS) {
      const { unmount } = render(
        <PriorityBadge card={makeCard({ priority: p })} />
      )
      // The visible chip text matches the label helper.
      expect(screen.getByText(priorityLabel(p))).toBeInTheDocument()
      // Tooltip-style title attribute carries the "Priority: <label>"
      // hint - also a good signal that the chip resolved metadata.
      expect(screen.getByTitle(`Priority: ${priorityLabel(p)}`)).toBeInTheDocument()
      unmount()
    }
  })

  it('renders nothing for an unknown / future-mode priority value', () => {
    // Defensive: a hand-edited DB or a forward-shape build can put
    // an unrecognised value here. The badge should bail out, not
    // crash on META[undefined].
    const { container } = render(
      <PriorityBadge card={makeCard({ priority: 'critical' as never })} />
    )
    expect(container.firstChild).toBeNull()
  })
})

describe('<PriorityPicker>', () => {
  it('fires a card.update mutation with the picked level', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    const close = vi.fn()
    render(
      <PriorityPicker card={makeCard()} apply={apply} close={close} />
    )

    await user.click(screen.getByRole('button', { name: /high/i }))
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply.mock.calls[0]![0]).toEqual({
      type: 'card.update',
      id: 'c1',
      patch: { priority: 'high' }
    })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('clicking the already-active level clears the priority', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    const close = vi.fn()
    render(
      <PriorityPicker
        card={makeCard({ priority: 'urgent' })}
        apply={apply}
        close={close}
      />
    )

    // The active level row keeps its label as the click target.
    await user.click(screen.getByRole('button', { name: /urgent.*clear/i }))
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply.mock.calls[0]![0]).toMatchObject({
      type: 'card.update',
      patch: { priority: null }
    })
    expect(close).toHaveBeenCalled()
  })

  it('shows the dedicated "No priority" row only when a priority is set', () => {
    const { unmount } = render(
      <PriorityPicker
        card={makeCard()}
        apply={vi.fn()}
        close={vi.fn()}
      />
    )
    expect(screen.queryByText(/no priority/i)).toBeNull()
    unmount()

    render(
      <PriorityPicker
        card={makeCard({ priority: 'medium' })}
        apply={vi.fn()}
        close={vi.fn()}
      />
    )
    expect(screen.getByText(/no priority/i)).toBeInTheDocument()
  })
})
