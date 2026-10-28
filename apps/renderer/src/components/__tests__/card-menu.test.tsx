import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {
  AttachmentView,
  CardView,
  LabelView,
  Mutation
} from '@kanbini/shared'
import { CardMenu } from '../card-menu'
import { ContextMenu } from '../ui/context-menu'
import { kanbiniMock } from '../../__tests__/_kanbini-mock'

// Tests for the right-click card menu - focused on the orchestration
// only (Cover / Complete / Delete). The composed children (labels,
// due date, priority) have their own test files; this suite asserts
// that CardMenu wires them up correctly + handles the three pieces
// it owns:
//   - Cover from file (two-step IPC: attachmentAdd + card.update)
//   - Cover from URL (lifts to parent via onRequestCoverFromUrl)
//   - Remove cover (conditional render based on coverAttachmentId)
//   - Mark complete / Mark incomplete (toggles `completed`)
//   - Delete card (danger action)

function makeCard(overrides: Partial<CardView> = {}): CardView {
  return {
    id: 'c1',
    number: 1,
    boardId: 'b1',
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
    collapsed: null,
    activities: [],
    blockedBy: [],
    blocking: [],
    repeat: null,
    ...overrides
  }
}

const NO_LABELS: LabelView[] = []

/** Open the menu for real: its fly-out rows need a ContextMenu around
 *  them. The CardMenu's own `close` prop stays the test's spy. */
function renderMenu(node: React.ReactElement): void {
  render(
    <ContextMenu menu={() => node}>
      {(open) => <button onContextMenu={open}>open menu</button>}
    </ContextMenu>
  )
  fireEvent.contextMenu(screen.getByRole('button', { name: 'open menu' }), {
    clientX: 10,
    clientY: 10
  })
}
/** A fly-out row (its name starts with the label, then the value). */
const flyoutRow = (label: string) =>
  screen.getByRole('button', { name: new RegExp(`^${label}`) })

describe('<CardMenu>', () => {
  it('lists the fly-out rows, each with its current value', () => {
    renderMenu(
      <CardMenu
        card={makeCard()}
        labels={NO_LABELS}
        apply={vi.fn()}
        close={vi.fn()}
        onRequestCoverFromUrl={vi.fn()}
      />
    )
    expect(flyoutRow('Labels')).toHaveTextContent('None')
    expect(flyoutRow('Due date')).toHaveTextContent('None')
    expect(flyoutRow('Repeat')).toHaveTextContent('Off')
    expect(flyoutRow('Priority')).toHaveTextContent('None')
    expect(flyoutRow('Cover')).toHaveTextContent('None')
    // The options themselves wait in the fly-outs.
    expect(screen.queryByText(/Set from file/)).toBeNull()
  })

  it('"Set from URL…" calls onRequestCoverFromUrl + closes the menu', async () => {
    const user = userEvent.setup()
    const close = vi.fn()
    const onRequestCoverFromUrl = vi.fn()
    renderMenu(
      <CardMenu
        card={makeCard()}
        labels={NO_LABELS}
        apply={vi.fn()}
        close={close}
        onRequestCoverFromUrl={onRequestCoverFromUrl}
      />
    )
    await user.click(flyoutRow('Cover'))
    await user.click(screen.getByText(/Set from URL/))
    expect(onRequestCoverFromUrl).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('"Set from file…" runs attachmentAdd → mutate(card.update) on success', async () => {
    const user = userEvent.setup()
    const close = vi.fn()
    const mock = kanbiniMock()
    const att: AttachmentView = {
      id: 'att-1',
      filename: 'pic.png',
      relPath: 'attachments/att-1/pic.png',
      mime: 'image/png',
      size: 1024,
      sourceUrl: null,
      sourceTitle: null,
      createdAt: 0
    }
    mock.attachmentAdd.mockResolvedValueOnce(att)
    renderMenu(
      <CardMenu
        card={makeCard()}
        labels={NO_LABELS}
        apply={vi.fn()}
        close={close}
        onRequestCoverFromUrl={vi.fn()}
      />
    )
    await user.click(flyoutRow('Cover'))
    await user.click(screen.getByText(/Set from file/))
    // Menu closes immediately on click - before the IPC resolves.
    expect(close).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(mock.attachmentAdd).toHaveBeenCalledWith('c1')
    })
    await waitFor(() => {
      expect(mock.mutate).toHaveBeenCalledWith({
        type: 'card.update',
        id: 'c1',
        patch: { coverAttachmentId: 'att-1' }
      })
    })
  })

  it('"Set from file…" skips card.update when the file dialog is cancelled', async () => {
    const user = userEvent.setup()
    const mock = kanbiniMock()
    mock.attachmentAdd.mockResolvedValueOnce(null)
    renderMenu(
      <CardMenu
        card={makeCard()}
        labels={NO_LABELS}
        apply={vi.fn()}
        close={vi.fn()}
        onRequestCoverFromUrl={vi.fn()}
      />
    )
    await user.click(flyoutRow('Cover'))
    await user.click(screen.getByText(/Set from file/))
    await waitFor(() => {
      expect(mock.attachmentAdd).toHaveBeenCalled()
    })
    expect(mock.mutate).not.toHaveBeenCalled()
  })

  it('"Set from file…" swallows IPC errors with a console warning', async () => {
    const user = userEvent.setup()
    const mock = kanbiniMock()
    mock.attachmentAdd.mockRejectedValueOnce(new Error('upload failed'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      renderMenu(
        <CardMenu
          card={makeCard()}
          labels={NO_LABELS}
          apply={vi.fn()}
          close={vi.fn()}
          onRequestCoverFromUrl={vi.fn()}
        />
      )
      await user.click(flyoutRow('Cover'))
      await user.click(screen.getByText(/Set from file/))
      await waitFor(() => {
        expect(warnSpy).toHaveBeenCalled()
      })
      // No card.update should fire after the upload throws.
      expect(mock.mutate).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('"Remove cover" is hidden when the card has no cover', async () => {
    renderMenu(
      <CardMenu
        card={makeCard({ coverAttachmentId: null })}
        labels={NO_LABELS}
        apply={vi.fn()}
        close={vi.fn()}
        onRequestCoverFromUrl={vi.fn()}
      />
    )
    await userEvent.setup().click(flyoutRow('Cover'))
    expect(screen.getByText(/Set from file/)).toBeInTheDocument()
    expect(screen.queryByText(/Remove cover/)).toBeNull()
  })

  it('"Remove cover" fires card.update with coverAttachmentId: null when set', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    const close = vi.fn()
    renderMenu(
      <CardMenu
        card={makeCard({ coverAttachmentId: 'att-1' })}
        labels={NO_LABELS}
        apply={apply}
        close={close}
        onRequestCoverFromUrl={vi.fn()}
      />
    )
    await user.click(flyoutRow('Cover'))
    await user.click(screen.getByText(/Remove cover/))
    expect(apply.mock.calls[0]![0]).toEqual({
      type: 'card.update',
      id: 'c1',
      patch: { coverAttachmentId: null }
    })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('"Mark complete" fires card.update toggling completed → true', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    renderMenu(
      <CardMenu
        card={makeCard({ completed: false })}
        labels={NO_LABELS}
        apply={apply}
        close={vi.fn()}
        onRequestCoverFromUrl={vi.fn()}
      />
    )
    await user.click(screen.getByText('Mark complete'))
    expect(apply.mock.calls[0]![0]).toEqual({
      type: 'card.update',
      id: 'c1',
      patch: { completed: true }
    })
  })

  it('"Mark incomplete" appears + fires when the card is already complete', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    renderMenu(
      <CardMenu
        card={makeCard({ completed: true })}
        labels={NO_LABELS}
        apply={apply}
        close={vi.fn()}
        onRequestCoverFromUrl={vi.fn()}
      />
    )
    await user.click(screen.getByText('Mark incomplete'))
    expect(apply.mock.calls[0]![0]).toEqual({
      type: 'card.update',
      id: 'c1',
      patch: { completed: false }
    })
  })

  it('"Delete card" fires card.delete + closes the menu', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    const close = vi.fn()
    renderMenu(
      <CardMenu
        card={makeCard()}
        labels={NO_LABELS}
        apply={apply}
        close={close}
        onRequestCoverFromUrl={vi.fn()}
      />
    )
    await user.click(screen.getByText('Delete card'))
    expect(apply.mock.calls[0]![0]).toEqual({
      type: 'card.delete',
      id: 'c1'
    })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('composed children render in their fly-outs - LabelToggleList, PriorityPicker', async () => {
    const user = userEvent.setup()
    const labels: LabelView[] = [
      { id: 'l1', name: 'Bug', color: 'oklch(0.62 0.17 25)' }
    ]
    renderMenu(
      <CardMenu
        card={makeCard({ priority: 'high' })}
        labels={labels}
        apply={vi.fn()}
        close={vi.fn()}
        onRequestCoverFromUrl={vi.fn()}
      />
    )
    // The row shows the current priority; the picker is in the fly-out.
    expect(flyoutRow('Priority')).toHaveTextContent('High')
    await user.click(flyoutRow('Labels'))
    expect(screen.getByRole('menu', { name: 'Labels' })).toHaveTextContent('Bug')
    await user.click(flyoutRow('Priority'))
    expect(screen.getByRole('menu', { name: 'Priority' })).toHaveTextContent('Urgent')
  })

  it('offers Collapse card when the host supplies a toggle', async () => {
    const onToggleCollapse = vi.fn()
    const close = vi.fn()
    renderMenu(
      <CardMenu
        card={makeCard()}
        labels={NO_LABELS}
        apply={vi.fn()}
        close={close}
        onRequestCoverFromUrl={vi.fn()}
        compact={false}
        onToggleCollapse={onToggleCollapse}
      />
    )
    await userEvent.setup().click(screen.getByText('Collapse card'))
    expect(onToggleCollapse).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('says Expand card on a compact card', () => {
    renderMenu(
      <CardMenu
        card={makeCard()}
        labels={NO_LABELS}
        apply={vi.fn()}
        close={vi.fn()}
        onRequestCoverFromUrl={vi.fn()}
        compact
        onToggleCollapse={vi.fn()}
      />
    )
    expect(screen.getByText('Expand card')).toBeInTheDocument()
  })

  it('leaves the item out when there is no toggle', () => {
    renderMenu(
      <CardMenu
        card={makeCard()}
        labels={NO_LABELS}
        apply={vi.fn()}
        close={vi.fn()}
        onRequestCoverFromUrl={vi.fn()}
      />
    )
    expect(screen.queryByText('Collapse card')).not.toBeInTheDocument()
    expect(screen.queryByText('Expand card')).not.toBeInTheDocument()
  })

  it('the rows read the card: its labels, due date, repeat, priority and cover', () => {
    const labels: LabelView[] = [
      { id: 'l1', name: 'Bug', color: 'red' },
      { id: 'l2', name: 'UI', color: 'blue' },
      { id: 'l3', name: 'Unused', color: 'green' }
    ]
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    renderMenu(
      <CardMenu
        card={makeCard({
          labelIds: ['l1', 'l2'],
          dueAt: today.getTime(),
          repeat: { unit: 'week', every: 1 },
          priority: 'urgent',
          coverAttachmentId: 'att-1'
        })}
        labels={labels}
        apply={vi.fn()}
        close={vi.fn()}
        onRequestCoverFromUrl={vi.fn()}
      />
    )
    expect(flyoutRow('Labels')).toHaveTextContent('Bug, UI')
    expect(flyoutRow('Due date')).toHaveTextContent('Today')
    expect(flyoutRow('Repeat')).toHaveTextContent('Every week')
    expect(flyoutRow('Priority')).toHaveTextContent('Urgent')
    expect(flyoutRow('Cover')).toHaveTextContent('On')
  })

  it('"Archive card" archives it (off the board, kept) + closes the menu', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    const close = vi.fn()
    renderMenu(
      <CardMenu
        card={makeCard()}
        labels={NO_LABELS}
        apply={apply}
        close={close}
        onRequestCoverFromUrl={vi.fn()}
      />
    )
    await user.click(screen.getByText('Archive card'))
    expect(apply.mock.calls[0]![0]).toEqual({
      type: 'card.update',
      id: 'c1',
      patch: { archived: true }
    })
    expect(close).toHaveBeenCalledTimes(1)
  })
})
