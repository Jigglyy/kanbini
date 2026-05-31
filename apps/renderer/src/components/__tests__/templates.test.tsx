import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { TemplateSummary } from '@kanbini/shared'
import {
  SaveTemplateDialog,
  TemplatePickerDialog,
  TemplatesManager
} from '../templates'
import { renderWithQuery } from '../../__tests__/_render'
import { kanbiniMock } from '../../__tests__/_kanbini-mock'

// Tests for the ADR-0038 templates surfaces. Three components +
// the housekeeping bugs that the polish pass caught:
//   - SaveTemplateDialog name validation + IPC routing
//   - TemplatePickerDialog filters by kind + handles missing
//     targetBoardId for the list kind
//   - TemplatesManager rename Escape doesn't blur-commit the typed
//     value (the skipBlurRef fix from the polish pass)

function makeSummary(overrides: Partial<TemplateSummary> = {}): TemplateSummary {
  return {
    id: 't1',
    kind: 'board',
    name: 'My template',
    createdAt: 0,
    updatedAt: 0,
    listCount: 2,
    cardCount: 5,
    ...overrides
  }
}

describe('<SaveTemplateDialog>', () => {
  it('renders nothing when closed', () => {
    const { container } = renderWithQuery(
      <SaveTemplateDialog
        open={false}
        kind="board"
        sourceId="b1"
        defaultName="My board"
        onClose={vi.fn()}
      />
    )
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('pre-fills the input with the defaultName + uses kind in the heading', async () => {
    renderWithQuery(
      <SaveTemplateDialog
        open
        kind="board"
        sourceId="b1"
        defaultName="My board"
        onClose={vi.fn()}
      />
    )
    expect(
      await screen.findByDisplayValue('My board')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: /save board as template/i })
    ).toBeInTheDocument()
  })

  it('list kind renders the list-flavoured heading', () => {
    renderWithQuery(
      <SaveTemplateDialog
        open
        kind="list"
        sourceId="l1"
        defaultName="Todo"
        onClose={vi.fn()}
      />
    )
    expect(
      screen.getByRole('heading', { name: /save list as template/i })
    ).toBeInTheDocument()
  })

  it('disables Save when the trimmed name is empty', async () => {
    const user = userEvent.setup()
    renderWithQuery(
      <SaveTemplateDialog
        open
        kind="board"
        sourceId="b1"
        defaultName="X"
        onClose={vi.fn()}
      />
    )
    const save = screen.getByRole('button', { name: /save template/i })
    expect(save).not.toBeDisabled()
    // Clear the input.
    const input = await screen.findByDisplayValue('X')
    await user.clear(input)
    expect(save).toBeDisabled()
    // Whitespace-only should also disable (the source trims first).
    await user.type(input, '   ')
    expect(save).toBeDisabled()
  })

  it('submits with the right shape + closes on success', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onSaved = vi.fn()
    renderWithQuery(
      <SaveTemplateDialog
        open
        kind="board"
        sourceId="b1"
        defaultName="X"
        onClose={onClose}
        onSaved={onSaved}
      />
    )
    const input = await screen.findByDisplayValue('X')
    await user.clear(input)
    await user.type(input, 'Bug triage')
    await user.click(screen.getByRole('button', { name: /save template/i }))
    await waitFor(() => {
      expect(kanbiniMock().templateSave).toHaveBeenCalledWith({
        kind: 'board',
        sourceId: 'b1',
        name: 'Bug triage'
      })
    })
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('surfaces an error from the IPC + leaves the dialog open', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    kanbiniMock().templateSave.mockRejectedValueOnce(
      new Error('Disk is on fire')
    )
    renderWithQuery(
      <SaveTemplateDialog
        open
        kind="board"
        sourceId="b1"
        defaultName="X"
        onClose={onClose}
      />
    )
    await user.click(screen.getByRole('button', { name: /save template/i }))
    expect(await screen.findByText('Disk is on fire')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Cancel fires onClose without saving', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderWithQuery(
      <SaveTemplateDialog
        open
        kind="board"
        sourceId="b1"
        defaultName="X"
        onClose={onClose}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(kanbiniMock().templateSave).not.toHaveBeenCalled()
  })
})

describe('<TemplatePickerDialog>', () => {
  it('filters by kind - board picker hides list templates', async () => {
    kanbiniMock().templateList.mockResolvedValue([
      makeSummary({ id: 't1', kind: 'board', name: 'Board tpl' }),
      makeSummary({ id: 't2', kind: 'list', name: 'List tpl' })
    ])
    renderWithQuery(
      <TemplatePickerDialog
        open
        kind="board"
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />
    )
    expect(await screen.findByText('Board tpl')).toBeInTheDocument()
    expect(screen.queryByText('List tpl')).toBeNull()
  })

  it('list picker filters out board templates', async () => {
    kanbiniMock().templateList.mockResolvedValue([
      makeSummary({ id: 't1', kind: 'board', name: 'Board tpl' }),
      makeSummary({ id: 't2', kind: 'list', name: 'List tpl' })
    ])
    renderWithQuery(
      <TemplatePickerDialog
        open
        kind="list"
        targetBoardId="b-target"
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />
    )
    expect(await screen.findByText('List tpl')).toBeInTheDocument()
    expect(screen.queryByText('Board tpl')).toBeNull()
  })

  it('shows the empty-state copy for a kind with no templates', async () => {
    kanbiniMock().templateList.mockResolvedValue([])
    renderWithQuery(
      <TemplatePickerDialog
        open
        kind="board"
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />
    )
    expect(
      await screen.findByText(/haven't saved a board template/i)
    ).toBeInTheDocument()
  })

  it('clicking a template calls instantiate + onCreated + onClose', async () => {
    const user = userEvent.setup()
    kanbiniMock().templateList.mockResolvedValue([
      makeSummary({ id: 't1', kind: 'board', name: 'Pick me' })
    ])
    kanbiniMock().templateInstantiate.mockResolvedValue({
      kind: 'board',
      boardId: 'new-board',
      listId: null
    })
    const onClose = vi.fn()
    const onCreated = vi.fn()
    renderWithQuery(
      <TemplatePickerDialog
        open
        kind="board"
        onClose={onClose}
        onCreated={onCreated}
      />
    )
    await user.click(await screen.findByText('Pick me'))
    await waitFor(() => {
      expect(kanbiniMock().templateInstantiate).toHaveBeenCalledWith({
        kind: 'board',
        templateId: 't1'
      })
    })
    expect(onCreated).toHaveBeenCalledWith({
      boardId: 'new-board',
      listId: null
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('list-kind picker passes the targetBoardId through to instantiate', async () => {
    const user = userEvent.setup()
    kanbiniMock().templateList.mockResolvedValue([
      makeSummary({ id: 't2', kind: 'list', name: 'List tpl' })
    ])
    kanbiniMock().templateInstantiate.mockResolvedValue({
      kind: 'list',
      boardId: 'b-target',
      listId: 'new-list'
    })
    renderWithQuery(
      <TemplatePickerDialog
        open
        kind="list"
        targetBoardId="b-target"
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />
    )
    await user.click(await screen.findByText('List tpl'))
    await waitFor(() => {
      expect(kanbiniMock().templateInstantiate).toHaveBeenCalledWith({
        kind: 'list',
        templateId: 't2',
        targetBoardId: 'b-target'
      })
    })
  })

  it('refuses to instantiate a list template without a targetBoardId', async () => {
    const user = userEvent.setup()
    kanbiniMock().templateList.mockResolvedValue([
      makeSummary({ id: 't2', kind: 'list', name: 'List tpl' })
    ])
    renderWithQuery(
      <TemplatePickerDialog
        open
        kind="list"
        // targetBoardId intentionally omitted - defensive guard in
        // the picker should surface an error instead of calling IPC.
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />
    )
    await user.click(await screen.findByText('List tpl'))
    expect(
      await screen.findByText(/couldn't determine which board/i)
    ).toBeInTheDocument()
    expect(kanbiniMock().templateInstantiate).not.toHaveBeenCalled()
  })
})

describe('<TemplatesManager>', () => {
  it('renders the empty-state copy when no templates exist', async () => {
    renderWithQuery(<TemplatesManager />)
    expect(
      await screen.findByText(/no templates saved yet/i)
    ).toBeInTheDocument()
  })

  it('lists every saved template with its name + counts label', async () => {
    kanbiniMock().templateList.mockResolvedValue([
      makeSummary({ id: 't1', kind: 'board', name: 'Board one', listCount: 3, cardCount: 12 }),
      makeSummary({ id: 't2', kind: 'list', name: 'List one', listCount: 1, cardCount: 4 })
    ])
    renderWithQuery(<TemplatesManager />)
    expect(await screen.findByText('Board one')).toBeInTheDocument()
    expect(screen.getByText('List one')).toBeInTheDocument()
    // Counts label format: "Board · N lists · N cards" or "List · N cards"
    expect(screen.getByText(/Board · 3 lists · 12 cards/)).toBeInTheDocument()
    expect(screen.getByText(/List · 4 cards/)).toBeInTheDocument()
  })

  it('Delete asks for confirmation; confirming fires templateDelete', async () => {
    const user = userEvent.setup()
    kanbiniMock().templateList.mockResolvedValue([
      makeSummary({ id: 't1', name: 'Doomed' })
    ])
    renderWithQuery(<TemplatesManager />)
    await screen.findByText('Doomed')
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    // After click, the confirmation row replaces the action buttons.
    const confirmDelete = await screen.findByRole('button', { name: 'Delete' })
    await user.click(confirmDelete)
    await waitFor(() => {
      expect(kanbiniMock().templateDelete).toHaveBeenCalledWith({ id: 't1' })
    })
  })

  it('Delete confirmation Cancel restores the action buttons', async () => {
    const user = userEvent.setup()
    kanbiniMock().templateList.mockResolvedValue([
      makeSummary({ id: 't1', name: 'Safe' })
    ])
    renderWithQuery(<TemplatesManager />)
    await screen.findByText('Safe')
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    // Back to the action row - Rename + Delete both present.
    expect(screen.getByRole('button', { name: 'Rename' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
    expect(kanbiniMock().templateDelete).not.toHaveBeenCalled()
  })

  it('Rename via Enter commits the new name through templateRename', async () => {
    const user = userEvent.setup()
    kanbiniMock().templateList.mockResolvedValue([
      makeSummary({ id: 't1', name: 'Old name' })
    ])
    renderWithQuery(<TemplatesManager />)
    await screen.findByText('Old name')
    await user.click(screen.getByRole('button', { name: 'Rename' }))
    const input = (await screen.findByDisplayValue('Old name')) as HTMLInputElement
    await user.clear(input)
    await user.type(input, 'New name')
    await user.keyboard('{Enter}')
    await waitFor(() => {
      expect(kanbiniMock().templateRename).toHaveBeenCalledWith({
        id: 't1',
        name: 'New name'
      })
    })
  })

  it('Rename via Escape ABORTS - even though the input unmounts + fires blur', async () => {
    // Regression for the polish-pass skipBlurRef fix: Escape sets
    // renamingId(null), the input unmounts, the browser fires blur on
    // the just-removed focused element, the bare onBlur would commit
    // the typed value. The flag has to bail the blur handler out.
    const user = userEvent.setup()
    kanbiniMock().templateList.mockResolvedValue([
      makeSummary({ id: 't1', name: 'Keep me' })
    ])
    renderWithQuery(<TemplatesManager />)
    await screen.findByText('Keep me')
    await user.click(screen.getByRole('button', { name: 'Rename' }))
    const input = (await screen.findByDisplayValue('Keep me')) as HTMLInputElement
    await user.clear(input)
    await user.type(input, 'This should not save')
    await user.keyboard('{Escape}')
    // Give any deferred blur a chance to fire.
    await new Promise((r) => setTimeout(r, 50))
    expect(kanbiniMock().templateRename).not.toHaveBeenCalled()
    // The list row should be back showing the original name.
    expect(screen.getByText('Keep me')).toBeInTheDocument()
  })
})
