import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BoardView, CardView, LabelView, Mutation } from '@kanbini/shared'
import {
  CardLabels,
  LabelBar,
  LabelToggleList,
  withLabelDelete,
  withLabelUpdate,
  withLabels
} from '../labels'

// Tests for the M1 labels surface - three components + the
// `withLabels` immutable cache transformer:
//   - CardLabels: read-only chip strip on the in-list card
//   - LabelBar: header filter chips + the "New label" popover
//   - LabelToggleList: multi-select editor inside the card menu
//   - withLabels: replaces a card's labelIds without touching siblings

const labels: LabelView[] = [
  { id: 'l1', name: 'Bug', color: 'oklch(0.62 0.17 25)' },
  { id: 'l2', name: 'Feature', color: 'oklch(0.62 0.15 250)' }
]

function makeCard(overrides: Partial<CardView> = {}): CardView {
  return {
    id: 'c1',
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

describe('withLabels', () => {
  it('replaces labelIds on the matching card without touching siblings', () => {
    const board = {
      project: { id: 'p', name: 'P' },
      board: {
        id: 'b1',
        name: 'B',
        color: null,
        background: null,
        swimlaneMode: null
      },
      labels,
      lists: [
        {
          id: 'l',
          name: 'L',
          color: null,
          closed: false,
          position: 'a',
          wipLimit: null,
          sortMode: null,
          onEnter: null,
          cards: [
            makeCard({ id: 'c1', labelIds: ['l1'] }),
            makeCard({ id: 'c2', labelIds: ['l2'] })
          ]
        }
      ]
    }
    const next = withLabels(board, 'c1', ['l1', 'l2'])
    expect(next.lists[0]!.cards[0]!.labelIds).toEqual(['l1', 'l2'])
    expect(next.lists[0]!.cards[1]!.labelIds).toEqual(['l2'])
  })
})

function makeBoardWith(labels: LabelView[], cardLabelIds: string[]): BoardView {
  return {
    project: { id: 'p', name: 'P' },
    board: {
      id: 'b1',
      name: 'B',
      color: null,
      background: null,
      swimlaneMode: null
    },
    labels,
    lists: [
      {
        id: 'l',
        name: 'L',
        color: null,
        closed: false,
        position: 'a',
        wipLimit: null,
        sortMode: null,
        onEnter: null,
        cards: [makeCard({ id: 'c1', labelIds: cardLabelIds })]
      }
    ]
  }
}

describe('withLabelUpdate', () => {
  it('patches the matching label and leaves the rest untouched', () => {
    const board = makeBoardWith(labels, [])
    const next = withLabelUpdate(board, 'l1', { name: 'Defect', color: 'x' })
    expect(next.labels[0]).toMatchObject({ id: 'l1', name: 'Defect', color: 'x' })
    expect(next.labels[1]).toBe(board.labels[1]) // sibling ref preserved
  })
})

describe('withLabelDelete', () => {
  it('drops the label AND scrubs it from every card that carried it', () => {
    const board = makeBoardWith(labels, ['l1', 'l2'])
    const next = withLabelDelete(board, 'l1')
    expect(next.labels.map((l) => l.id)).toEqual(['l2'])
    expect(next.lists[0]!.cards[0]!.labelIds).toEqual(['l2'])
  })
})

describe('<CardLabels>', () => {
  it('renders nothing when the card has no labels', () => {
    const { container } = render(
      <CardLabels labelIds={[]} labels={labels} />
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders one chip per resolved label, skipping unknown ids', () => {
    render(<CardLabels labelIds={['l1', 'unknown-id', 'l2']} labels={labels} />)
    expect(screen.getByText('Bug')).toBeInTheDocument()
    expect(screen.getByText('Feature')).toBeInTheDocument()
    expect(screen.queryByText('unknown-id')).toBeNull()
  })

  it('collapses to colour bars (no text) when expanded={false}', () => {
    render(
      <CardLabels labelIds={['l1', 'l2']} labels={labels} expanded={false} />
    )
    // Names are hidden in bar mode...
    expect(screen.queryByText('Bug')).toBeNull()
    expect(screen.queryByText('Feature')).toBeNull()
    // ...but still reachable via the bar's title/aria-label (hover + SR).
    expect(screen.getByTitle('Bug')).toBeInTheDocument()
    expect(screen.getByTitle('Feature')).toBeInTheDocument()
  })

  it('bars are inert (not buttons) without onToggleExpand', () => {
    render(<CardLabels labelIds={['l1']} labels={labels} expanded={false} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('clicking a bar fires onToggleExpand (reveal names) when provided', async () => {
    const user = userEvent.setup()
    const onToggleExpand = vi.fn()
    render(
      <CardLabels
        labelIds={['l1']}
        labels={labels}
        expanded={false}
        onToggleExpand={onToggleExpand}
      />
    )
    await user.click(screen.getByRole('button', { name: /Label Bug/i }))
    expect(onToggleExpand).toHaveBeenCalledTimes(1)
  })

  it('clicking a name chip fires onToggleExpand (collapse) when provided', async () => {
    const user = userEvent.setup()
    const onToggleExpand = vi.fn()
    render(
      <CardLabels
        labelIds={['l1']}
        labels={labels}
        expanded
        onToggleExpand={onToggleExpand}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Bug' }))
    expect(onToggleExpand).toHaveBeenCalledTimes(1)
  })
})

describe('<LabelBar>', () => {
  it('renders one filter chip per label', () => {
    render(
      <LabelBar
        boardId="b1"
        labels={labels}
        active={new Set()}
        onToggle={vi.fn()}
        apply={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: 'Bug' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Feature' })).toBeInTheDocument()
  })

  it('clicking a chip fires onToggle with its id', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    render(
      <LabelBar
        boardId="b1"
        labels={labels}
        active={new Set()}
        onToggle={onToggle}
        apply={vi.fn()}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Bug' }))
    expect(onToggle).toHaveBeenCalledWith('l1')
  })

  it('marks the active filter chip as pressed (selected state)', () => {
    const { container } = render(
      <LabelBar
        boardId="b1"
        labels={labels}
        active={new Set(['l1'])}
        onToggle={vi.fn()}
        apply={vi.fn()}
      />
    )
    const bugChip = container.querySelector(
      'button[title^="Filtering by this label"]'
    ) as HTMLElement
    expect(bugChip).not.toBeNull()
    expect(bugChip.textContent).toBe('Bug')
    expect(bugChip).toHaveAttribute('aria-pressed', 'true')
    // an un-filtered chip is not pressed
    const scriptingChip = container.querySelector(
      'button[title^="Filter by this label"]'
    ) as HTMLElement
    expect(scriptingChip).toHaveAttribute('aria-pressed', 'false')
  })

  it('"New label" popover opens + creates a label.create mutation', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    render(
      <LabelBar
        boardId="b1"
        labels={labels}
        active={new Set()}
        onToggle={vi.fn()}
        apply={apply}
      />
    )
    await user.click(screen.getByRole('button', { name: /new label/i }))
    const input = await screen.findByPlaceholderText('Label name')
    await user.type(input, 'Tracking')
    await user.click(screen.getByRole('button', { name: /add label/i }))
    expect(apply).toHaveBeenCalledTimes(1)
    const [mutation] = apply.mock.calls[0]!
    expect(mutation).toMatchObject({
      type: 'label.create',
      boardId: 'b1',
      name: 'Tracking',
      color: expect.stringContaining('oklch') // ACCENTS[0] default
    })
  })

  it('"New label" popover does NOT fire label.create when name is empty', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    render(
      <LabelBar
        boardId="b1"
        labels={labels}
        active={new Set()}
        onToggle={vi.fn()}
        apply={apply}
      />
    )
    await user.click(screen.getByRole('button', { name: /new label/i }))
    await screen.findByPlaceholderText('Label name')
    await user.click(screen.getByRole('button', { name: /add label/i }))
    expect(apply).not.toHaveBeenCalled()
  })
})

describe('<LabelBar> drag reorder', () => {
  it('renders chips as sortable drag handles but still toggles on a plain click', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    render(
      <LabelBar
        boardId="b1"
        labels={labels}
        active={new Set()}
        onToggle={onToggle}
        onReorder={vi.fn()}
        apply={vi.fn()}
      />
    )
    const bug = screen.getByRole('button', { name: 'Bug' })
    // The chip is the drag handle (cursor-grab) + dnd-kit tags it for AT.
    expect(bug.className).toContain('cursor-grab')
    expect(bug).toHaveAttribute('aria-roledescription', 'sortable')
    // A click with no movement must NOT be swallowed by the drag sensor.
    await user.click(bug)
    expect(onToggle).toHaveBeenCalledWith('l1')
  })

  it('right-click still opens the editor when reorder is enabled', () => {
    render(
      <LabelBar
        boardId="b1"
        labels={labels}
        active={new Set()}
        onToggle={vi.fn()}
        onReorder={vi.fn()}
        apply={vi.fn()}
      />
    )
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Bug' }))
    expect(screen.getByText('Rename label')).toBeInTheDocument()
  })
})

describe('<LabelBar> right-click editor', () => {
  function renderBar(apply = vi.fn<(m: Mutation, o: unknown) => void>()) {
    render(
      <LabelBar
        boardId="b1"
        labels={labels}
        active={new Set()}
        onToggle={vi.fn()}
        apply={apply}
      />
    )
    return apply
  }

  /** The editor opens via the chip's native context menu (right-click);
   *  userEvent has no right-click helper that drives React's
   *  onContextMenu, so fire it directly on the chip. */
  function openEditor(labelName: string): void {
    fireEvent.contextMenu(screen.getByRole('button', { name: labelName }))
  }

  it('right-clicking a chip opens the rename/colour/delete editor', () => {
    renderBar()
    expect(screen.queryByText('Rename label')).toBeNull()
    openEditor('Bug')
    expect(screen.getByText('Rename label')).toBeInTheDocument()
    expect(screen.getByText('Delete label')).toBeInTheDocument()
    // Pre-filled with the current name.
    expect(screen.getByPlaceholderText('Label name')).toHaveValue('Bug')
  })

  it('renaming via Enter fires label.update with the new name', async () => {
    const user = userEvent.setup()
    const apply = renderBar()
    openEditor('Bug')
    const input = screen.getByPlaceholderText('Label name')
    await user.clear(input)
    await user.type(input, 'Defect{Enter}')
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply.mock.calls[0]![0]).toEqual({
      type: 'label.update',
      id: 'l1',
      patch: { name: 'Defect' }
    })
  })

  it('does NOT fire when the name is unchanged', async () => {
    const user = userEvent.setup()
    const apply = renderBar()
    openEditor('Bug')
    const input = screen.getByPlaceholderText('Label name')
    await user.type(input, '{Enter}') // committed without editing
    expect(apply).not.toHaveBeenCalled()
  })

  it('picking a colour swatch fires label.update with that colour', async () => {
    const user = userEvent.setup()
    const apply = renderBar()
    openEditor('Bug')
    // The swatches carry an aria-label of `Colour <oklch(...)>`; click
    // any swatch that isn't Bug's current colour.
    const swatches = screen.getAllByLabelText(/^Colour oklch/)
    const other = swatches.find(
      (s) => s.getAttribute('aria-label') !== `Colour ${labels[0]!.color}`
    )!
    await user.click(other)
    expect(apply).toHaveBeenCalledTimes(1)
    const [mutation] = apply.mock.calls[0]!
    expect(mutation).toMatchObject({ type: 'label.update', id: 'l1' })
    expect((mutation as { patch: { color?: string } }).patch.color).toMatch(
      /oklch/
    )
  })

  it('Delete label fires label.delete', async () => {
    const user = userEvent.setup()
    const apply = renderBar()
    openEditor('Bug')
    await user.click(screen.getByText('Delete label'))
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply.mock.calls[0]![0]).toEqual({ type: 'label.delete', id: 'l1' })
  })

  it('offers Move right (not left) for the first chip and fires onMove', async () => {
    const user = userEvent.setup()
    const onMove = vi.fn()
    render(
      <LabelBar
        boardId="b1"
        labels={labels}
        active={new Set()}
        onToggle={vi.fn()}
        onMove={onMove}
        apply={vi.fn()}
      />
    )
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Bug' }))
    expect(screen.queryByText(/Move left/)).toBeNull()
    await user.click(screen.getByText(/Move right/))
    expect(onMove).toHaveBeenCalledWith('l1', 1)
  })

  it('offers Move left (not right) for the last chip and fires onMove', async () => {
    const user = userEvent.setup()
    const onMove = vi.fn()
    render(
      <LabelBar
        boardId="b1"
        labels={labels}
        active={new Set()}
        onToggle={vi.fn()}
        onMove={onMove}
        apply={vi.fn()}
      />
    )
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Feature' }))
    expect(screen.queryByText(/Move right/)).toBeNull()
    await user.click(screen.getByText(/Move left/))
    expect(onMove).toHaveBeenCalledWith('l2', -1)
  })

  it('omits the reorder actions entirely when onMove is not provided', () => {
    render(
      <LabelBar
        boardId="b1"
        labels={labels}
        active={new Set()}
        onToggle={vi.fn()}
        apply={vi.fn()}
      />
    )
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Bug' }))
    expect(screen.queryByText(/Move (left|right)/)).toBeNull()
  })

  it('surfaces an orphaned (non-palette) colour as a selected swatch', () => {
    // A label saved under an older palette carries a colour that is no
    // longer a standard swatch. The editor should still show it (so it
    // doesn't read as "nothing selected") - rendered as an extra
    // highlighted swatch via swatchOptions.
    const orphan = 'oklch(0.62 0.15 250)' // pre-retune blue
    render(
      <LabelBar
        boardId="b1"
        labels={[{ id: 'lx', name: 'Old', color: orphan }]}
        active={new Set()}
        onToggle={vi.fn()}
        apply={vi.fn()}
      />
    )
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Old' }))
    const orphanSwatch = screen.getByLabelText(`Colour ${orphan}`)
    expect(orphanSwatch).toBeInTheDocument()
    // It's the selected one (ring), since it's the label's current colour.
    expect(orphanSwatch.className).toContain('ring-2')
  })
})

describe('<LabelToggleList>', () => {
  it('renders the "no labels yet" hint when the board has none', () => {
    render(
      <LabelToggleList card={makeCard()} labels={[]} apply={vi.fn()} />
    )
    expect(screen.getByText(/no labels yet/i)).toBeInTheDocument()
  })

  it('clicking an unassigned label adds it via card.setLabels', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    render(
      <LabelToggleList
        card={makeCard({ labelIds: [] })}
        labels={labels}
        apply={apply}
      />
    )
    await user.click(screen.getByRole('button', { name: /Bug/ }))
    expect(apply.mock.calls[0]![0]).toEqual({
      type: 'card.setLabels',
      id: 'c1',
      labelIds: ['l1']
    })
  })

  it('clicking an already-assigned label removes it', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    render(
      <LabelToggleList
        card={makeCard({ labelIds: ['l1', 'l2'] })}
        labels={labels}
        apply={apply}
      />
    )
    await user.click(screen.getByRole('button', { name: /Bug/ }))
    expect(apply.mock.calls[0]![0]).toEqual({
      type: 'card.setLabels',
      id: 'c1',
      labelIds: ['l2']
    })
  })

  it('renders a check mark on already-assigned rows', () => {
    render(
      <LabelToggleList
        card={makeCard({ labelIds: ['l1'] })}
        labels={labels}
        apply={vi.fn()}
      />
    )
    // The check character ✓ appears next to Bug, not Feature.
    const bugRow = screen.getByRole('button', { name: /Bug/ })
    const featureRow = screen.getByRole('button', { name: /Feature/ })
    expect(bugRow.textContent).toContain('✓')
    expect(featureRow.textContent).not.toContain('✓')
  })
})
