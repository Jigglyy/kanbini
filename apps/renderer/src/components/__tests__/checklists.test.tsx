import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {
  CardView,
  ChecklistItemView,
  ChecklistView,
  Mutation
} from '@kanbini/shared'
import { CardChecklistPreview } from '../checklists'

// Component tests for the in-list card-preview checklist pill
// (ADR-0029). The visual contract:
//   - bail out entirely if every checklist is empty
//   - one collapsible pill per non-empty checklist
//   - collapsed by default; click toggles + persists to localStorage
//   - items render once expanded; clicking an item toggles via `apply`
//   - card.completed forces strike-through on every visible item
//
// Note on module-level state: `expandedIds` is a Set loaded once at
// module import time (see comment in checklists.tsx). Each test uses
// unique checklist ids so the prior test's expanded state can't bleed
// into the next.

let nextId = 0
function uniqueId(prefix: string): string {
  nextId += 1
  return `${prefix}-test-${nextId}`
}

function makeItem(
  overrides: Partial<ChecklistItemView> = {}
): ChecklistItemView {
  return {
    id: uniqueId('it'),
    text: 'Item',
    completed: false,
    position: 'a',
    ...overrides
  }
}
function makeChecklist(
  overrides: Partial<ChecklistView> = {}
): ChecklistView {
  return {
    id: uniqueId('cl'),
    name: 'Steps',
    position: 'a',
    items: [makeItem({ text: 'One' }), makeItem({ text: 'Two' })],
    ...overrides
  }
}
function makeCard(overrides: Partial<CardView> = {}): CardView {
  return {
    id: uniqueId('c'),
    title: 'Card',
    description: null,
    position: 'a',
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

describe('<CardChecklistPreview>', () => {
  it('renders nothing when every checklist is empty', () => {
    const { container } = render(
      <CardChecklistPreview
        card={makeCard({
          checklists: [makeChecklist({ items: [] })]
        })}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when the card has no checklists', () => {
    const { container } = render(<CardChecklistPreview card={makeCard()} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders a pill per non-empty checklist with the right count', () => {
    const card = makeCard({
      checklists: [
        makeChecklist({ name: 'A', items: [makeItem({ completed: true })] }),
        makeChecklist({
          name: 'B',
          items: [makeItem(), makeItem(), makeItem({ completed: true })]
        }),
        makeChecklist({ name: 'Empty', items: [] }) // filtered out
      ]
    })
    render(<CardChecklistPreview card={card} />)
    // A: 1/1, B: 1/3, Empty: not rendered
    expect(screen.getByText('1/1')).toBeInTheDocument()
    expect(screen.getByText('1/3')).toBeInTheDocument()
    expect(screen.queryByText('0/0')).toBeNull()
    expect(screen.getByText('A')).toBeInTheDocument()
    expect(screen.getByText('B')).toBeInTheDocument()
    expect(screen.queryByText('Empty')).toBeNull()
  })

  it('starts collapsed (items hidden) and expands on click', async () => {
    const user = userEvent.setup()
    const cl = makeChecklist({
      name: 'Hidden',
      items: [makeItem({ text: 'first' }), makeItem({ text: 'second' })]
    })
    render(<CardChecklistPreview card={makeCard({ checklists: [cl] })} />)

    // Collapsed: pill shows but items don't.
    const pill = screen.getByRole('button', { name: /expand checklist/i })
    expect(pill).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('first')).toBeNull()

    await user.click(pill)
    expect(pill).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('first')).toBeInTheDocument()
    expect(screen.getByText('second')).toBeInTheDocument()
  })

  it('persists expanded state to localStorage', async () => {
    const user = userEvent.setup()
    const cl = makeChecklist({
      id: uniqueId('cl-persist'),
      items: [makeItem({ text: 'only' })]
    })
    render(<CardChecklistPreview card={makeCard({ checklists: [cl] })} />)
    await user.click(screen.getByRole('button', { name: /expand checklist/i }))
    const raw = localStorage.getItem('kanbini.expandedChecklists')
    expect(raw).toBeTruthy()
    const ids: unknown = JSON.parse(raw!)
    expect(Array.isArray(ids)).toBe(true)
    expect((ids as string[]).includes(cl.id)).toBe(true)
  })

  it('fires checklistItem.update when an item checkbox is clicked', async () => {
    const user = userEvent.setup()
    const item = makeItem({ text: 'tick me', completed: false })
    const cl = makeChecklist({ items: [item] })
    const card = makeCard({ checklists: [cl] })
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()

    render(<CardChecklistPreview card={card} apply={apply} />)
    // Expand first so the item is in the DOM.
    await user.click(screen.getByRole('button', { name: /expand checklist/i }))
    // Item-level checkbox carries its own aria-label.
    await user.click(screen.getByRole('button', { name: 'Mark complete' }))

    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply.mock.calls[0]![0]).toEqual({
      type: 'checklistItem.update',
      id: item.id,
      patch: { completed: true }
    })
  })

  it('omits the toggle action when `apply` is not supplied (drag-overlay use)', async () => {
    const user = userEvent.setup()
    const item = makeItem({ text: 'static', completed: false })
    const cl = makeChecklist({ items: [item] })
    render(<CardChecklistPreview card={makeCard({ checklists: [cl] })} />)
    await user.click(screen.getByRole('button', { name: /expand checklist/i }))
    // Click the item checkbox - no apply, so no mutation fires. The
    // button still exists (we don't toggle visibility) but the click
    // is a no-op. Tested by lack of throw + absence of any obvious
    // state change.
    await user.click(screen.getByRole('button', { name: 'Mark complete' }))
    // Item still says incomplete (no state to flip without apply).
    expect(
      screen.getByRole('button', { name: 'Mark complete' })
    ).toBeInTheDocument()
  })
})
