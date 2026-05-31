import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {
  AttachmentView,
  CardView,
  LabelView,
  Mutation
} from '@kanbini/shared'
import { CardMenu } from '../card-menu'
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

const NO_LABELS: LabelView[] = []

describe('<CardMenu>', () => {
  it('renders the section labels in order (Labels / Due date / Cover)', () => {
    render(
      <CardMenu
        card={makeCard()}
        labels={NO_LABELS}
        apply={vi.fn()}
        close={vi.fn()}
        onRequestCoverFromUrl={vi.fn()}
      />
    )
    expect(screen.getByText('Labels')).toBeInTheDocument()
    expect(screen.getByText('Due date')).toBeInTheDocument()
    expect(screen.getByText('Cover')).toBeInTheDocument()
  })

  it('"Set from URL…" calls onRequestCoverFromUrl + closes the menu', async () => {
    const user = userEvent.setup()
    const close = vi.fn()
    const onRequestCoverFromUrl = vi.fn()
    render(
      <CardMenu
        card={makeCard()}
        labels={NO_LABELS}
        apply={vi.fn()}
        close={close}
        onRequestCoverFromUrl={onRequestCoverFromUrl}
      />
    )
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
    render(
      <CardMenu
        card={makeCard()}
        labels={NO_LABELS}
        apply={vi.fn()}
        close={close}
        onRequestCoverFromUrl={vi.fn()}
      />
    )
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
    render(
      <CardMenu
        card={makeCard()}
        labels={NO_LABELS}
        apply={vi.fn()}
        close={vi.fn()}
        onRequestCoverFromUrl={vi.fn()}
      />
    )
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
      render(
        <CardMenu
          card={makeCard()}
          labels={NO_LABELS}
          apply={vi.fn()}
          close={vi.fn()}
          onRequestCoverFromUrl={vi.fn()}
        />
      )
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

  it('"Remove cover" is hidden when the card has no cover', () => {
    render(
      <CardMenu
        card={makeCard({ coverAttachmentId: null })}
        labels={NO_LABELS}
        apply={vi.fn()}
        close={vi.fn()}
        onRequestCoverFromUrl={vi.fn()}
      />
    )
    expect(screen.queryByText(/Remove cover/)).toBeNull()
  })

  it('"Remove cover" fires card.update with coverAttachmentId: null when set', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    const close = vi.fn()
    render(
      <CardMenu
        card={makeCard({ coverAttachmentId: 'att-1' })}
        labels={NO_LABELS}
        apply={apply}
        close={close}
        onRequestCoverFromUrl={vi.fn()}
      />
    )
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
    render(
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
    render(
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
    render(
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

  it('composed children render - LabelToggleList, DueEditor, PriorityPicker', () => {
    const labels: LabelView[] = [
      { id: 'l1', name: 'Bug', color: 'oklch(0.62 0.17 25)' }
    ]
    render(
      <CardMenu
        card={makeCard({ priority: 'high' })}
        labels={labels}
        apply={vi.fn()}
        close={vi.fn()}
        onRequestCoverFromUrl={vi.fn()}
      />
    )
    // LabelToggleList shows the label row.
    expect(screen.getByRole('button', { name: /Bug/ })).toBeInTheDocument()
    // PriorityPicker renders the four-level radio strip; "High" should
    // appear (active state highlights it but the label is in the DOM).
    expect(screen.getByText('High')).toBeInTheDocument()
  })
})
