import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CardView } from '@kanbini/shared'
import { CollapseToggle, CompactBadges } from '../card-density'

// A compact card drops its cover, URL chip, and checklist items, so
// CompactBadges is what still tells you there's more on the card.

function makeCard(overrides: Partial<CardView> = {}): CardView {
  return {
    id: 'c1',
    title: 'Card',
    description: null,
    position: 'a',
    completed: false,
    dueAt: null,
    priority: null,
    collapsed: null,
    labelIds: [],
    checklists: [],
    comments: [],
    attachments: [],
    coverAttachmentId: null,
    activities: [],
    ...overrides
  }
}

describe('<CompactBadges>', () => {
  it('renders nothing for a bare card', () => {
    const { container } = render(<CompactBadges card={makeCard()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows checklist progress, comment and attachment counts', () => {
    render(
      <CompactBadges
        card={makeCard({
          checklists: [
            {
              id: 'k',
              name: 'Steps',
              position: 'a',
              items: [
                { id: 'i1', text: 'a', completed: true, position: 'a' },
                { id: 'i2', text: 'b', completed: false, position: 'b' }
              ]
            }
          ],
          comments: [
            { id: 'm1', body: 'x', author: null, createdAt: 1, updatedAt: 1 },
            { id: 'm2', body: 'y', author: null, createdAt: 2, updatedAt: 2 }
          ],
          attachments: [
            {
              id: 'a1',
              filename: 'f.txt',
              relPath: 'attachments/a1/f.txt',
              mime: 'text/plain',
              size: 1,
              sourceUrl: null,
              sourceTitle: null,
              createdAt: 1
            }
          ]
        })}
      />
    )
    expect(screen.getByTitle('1 of 2 checklist items done')).toHaveTextContent('1/2')
    expect(screen.getByTitle('2 comments')).toHaveTextContent('2')
    expect(screen.getByTitle('1 attachment')).toHaveTextContent('1')
  })

  it('skips a count that is zero', () => {
    render(
      <CompactBadges
        card={makeCard({
          comments: [{ id: 'm1', body: 'x', author: null, createdAt: 1, updatedAt: 1 }]
        })}
      />
    )
    expect(screen.getByTitle('1 comment')).toBeInTheDocument()
    expect(screen.queryByTitle(/checklist/)).not.toBeInTheDocument()
    expect(screen.queryByTitle(/attachment/)).not.toBeInTheDocument()
  })
})

describe('<CollapseToggle>', () => {
  it('labels itself by what a click will do', () => {
    const { rerender } = render(<CollapseToggle compact={false} onToggle={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Collapse card' })).toBeInTheDocument()
    rerender(<CollapseToggle compact onToggle={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Expand card' })).toBeInTheDocument()
  })

  it('toggles on click', async () => {
    const onToggle = vi.fn()
    render(<CollapseToggle compact={false} onToggle={onToggle} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Collapse card' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('never lets a press start a card drag', () => {
    const parent = vi.fn()
    render(
      <div onPointerDown={parent}>
        <CollapseToggle compact={false} onToggle={vi.fn()} />
      </div>
    )
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Collapse card' }))
    expect(parent).not.toHaveBeenCalled()
  })
})
