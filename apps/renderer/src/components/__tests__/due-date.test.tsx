import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CardView, Mutation } from '@kanbini/shared'
import {
  DueBadge,
  DueEditor,
  fromInputValue,
  patchDue,
  toInputValue
} from '../due-date'

// Tests for the M1 due-date layer. Three surfaces:
//   - DueBadge: the in-list chip; overdue styling depends on the live
//     clock + the completed flag.
//   - DueEditor: the right-click menu input + Clear button.
//   - toInputValue / fromInputValue: local-midnight serialization.

function makeCard(overrides: Partial<CardView> = {}): CardView {
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

afterEach(() => {
  vi.useRealTimers()
})

describe('toInputValue / fromInputValue', () => {
  it('round-trips a local-midnight epoch through the YYYY-MM-DD format', () => {
    // The pair is meant to be inverse for whole-day values. We use
    // new Date(year, month-1, day) for the inverse so the test stays
    // in the local timezone - same code path as the source.
    const original = new Date(2026, 4, 15).getTime() // 2026-05-15 local midnight
    const str = toInputValue(original)
    expect(str).toBe('2026-05-15')
    expect(fromInputValue(str)).toBe(original)
  })

  it('pads single-digit month + day with leading zeros', () => {
    const ms = new Date(2026, 0, 5).getTime() // 2026-01-05 local
    expect(toInputValue(ms)).toBe('2026-01-05')
  })

  it('does not throw on partial / empty input', () => {
    // The `?? 1970` fallback in the source only fires for null /
    // undefined - `Number('') === 0`, NOT undefined, so an empty
    // string actually resolves to year 0 (Date(0, 0, 1)). In
    // practice the DueEditor's `e.target.value &&` guard prevents
    // an empty string from ever reaching here, so this is a
    // never-fires path; just confirm it returns a finite number
    // rather than NaN / throws.
    expect(Number.isFinite(fromInputValue(''))).toBe(true)
    // Partial input ('2026') treats the missing month + day as the
    // defaults from `??` - month 1, day 1.
    expect(fromInputValue('2026')).toBe(new Date(2026, 0, 1).getTime())
  })
})

describe('patchDue', () => {
  it('sets dueAt on the matching card; leaves siblings alone', () => {
    const board = {
      project: { id: 'p', name: 'P' },
      board: {
        id: 'b1',
        name: 'B',
        color: null,
        background: null,
        swimlaneMode: null
      },
      labels: [],
      lists: [
        {
          id: 'l1',
          name: 'L',
          color: null,
          closed: false,
          position: 'a',
          wipLimit: null,
          sortMode: null,
          onEnter: null,
          cards: [makeCard({ id: 'c1' }), makeCard({ id: 'c2' })]
        }
      ]
    }
    const next = patchDue(board, 'c1', 1234)
    expect(next.lists[0]!.cards[0]!.dueAt).toBe(1234)
    expect(next.lists[0]!.cards[1]!.dueAt).toBeNull()
  })

  it('clears dueAt when null is passed', () => {
    const board = {
      project: { id: 'p', name: 'P' },
      board: {
        id: 'b1',
        name: 'B',
        color: null,
        background: null,
        swimlaneMode: null
      },
      labels: [],
      lists: [
        {
          id: 'l1',
          name: 'L',
          color: null,
          closed: false,
          position: 'a',
          wipLimit: null,
          sortMode: null,
          onEnter: null,
          cards: [makeCard({ id: 'c1', dueAt: 1234 })]
        }
      ]
    }
    expect(patchDue(board, 'c1', null).lists[0]!.cards[0]!.dueAt).toBeNull()
  })
})

describe('<DueBadge>', () => {
  it('renders nothing when the card has no due date', () => {
    const { container } = render(<DueBadge card={makeCard()} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the formatted date for a due card', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 1))
    const due = new Date(2026, 4, 15).getTime()
    render(<DueBadge card={makeCard({ dueAt: due })} />)
    // Date format: 'short' month + numeric day. "May 15" in en-US.
    // Locale-agnostic check - assert the day is present.
    expect(screen.getByText(/15/)).toBeInTheDocument()
  })

  it('applies the overdue colour class when the due date has passed AND the card is open', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 5, 1)) // June 1, 2026
    const due = new Date(2026, 4, 15).getTime() // May 15
    const { container } = render(
      <DueBadge card={makeCard({ dueAt: due, completed: false })} />
    )
    const chip = container.firstChild as HTMLElement
    expect(chip.className).toContain('text-red-400')
  })

  it('does NOT mark overdue when the card is completed (even if past due)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 5, 1))
    const due = new Date(2026, 4, 15).getTime()
    const { container } = render(
      <DueBadge card={makeCard({ dueAt: due, completed: true })} />
    )
    const chip = container.firstChild as HTMLElement
    expect(chip.className).not.toContain('text-red-400')
    expect(chip.className).toContain('text-muted-foreground')
  })

  it('does NOT mark overdue when the due date is in the future', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 1))
    const due = new Date(2026, 4, 15).getTime()
    const { container } = render(
      <DueBadge card={makeCard({ dueAt: due, completed: false })} />
    )
    const chip = container.firstChild as HTMLElement
    expect(chip.className).not.toContain('text-red-400')
  })
})

describe('<DueEditor>', () => {
  it('fires card.update with the picked date + closes the menu', () => {
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    const close = vi.fn()
    render(<DueEditor card={makeCard()} apply={apply} close={close} />)

    const input = screen.getByDisplayValue('') as HTMLInputElement
    // fireEvent.change drives the native onChange path that the source
    // uses (`(e) => e.target.value && set(...)`).
    fireEvent.change(input, { target: { value: '2026-05-15' } })

    expect(apply).toHaveBeenCalledTimes(1)
    const [mutation] = apply.mock.calls[0]!
    expect(mutation).toEqual({
      type: 'card.update',
      id: 'c1',
      patch: { dueAt: new Date(2026, 4, 15).getTime() }
    })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('skips the mutation when the input is cleared (empty string)', () => {
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    const close = vi.fn()
    render(
      <DueEditor
        card={makeCard({ dueAt: new Date(2026, 4, 15).getTime() })}
        apply={apply}
        close={close}
      />
    )
    const input = screen.getByDisplayValue('2026-05-15') as HTMLInputElement
    // User backspacing the input down to empty - date pickers fire an
    // empty-string change before they emit the new value. The handler
    // guards with `e.target.value &&` so this is a no-op.
    fireEvent.change(input, { target: { value: '' } })
    expect(apply).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it('renders the Clear button only when a due date is set', () => {
    const { rerender } = render(
      <DueEditor card={makeCard()} apply={vi.fn()} close={vi.fn()} />
    )
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
    rerender(
      <DueEditor
        card={makeCard({ dueAt: new Date(2026, 4, 15).getTime() })}
        apply={vi.fn()}
        close={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument()
  })

  it('Clear fires card.update with dueAt: null', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    const close = vi.fn()
    render(
      <DueEditor
        card={makeCard({ dueAt: new Date(2026, 4, 15).getTime() })}
        apply={apply}
        close={close}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Clear' }))
    expect(apply.mock.calls[0]![0]).toEqual({
      type: 'card.update',
      id: 'c1',
      patch: { dueAt: null }
    })
    expect(close).toHaveBeenCalled()
  })
})
