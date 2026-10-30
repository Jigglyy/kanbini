import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BoardSummary, BoardView, CardView } from '@kanbini/shared'
import { CardTransferDialog, transferMutations } from '../card-transfer'
import { renderWithQuery } from '../../__tests__/_render'
import { kanbiniMock } from '../../__tests__/_kanbini-mock'

// The Move / Copy dialog (card menu "Move..." / "Copy...", multi-select
// "Move to another board..."). The server does the label matching and
// numbering (card-copy.test.ts in @kanbini/db); here: the placement maths,
// what the dialog sends, and what it shows after a move to another board.

describe('transferMutations', () => {
  const list = ['x', 'y', 'z']

  it('bottom: no neighbours, so the cards append in order', () => {
    expect(
      transferMutations({ mode: 'move', cardIds: ['a', 'b'], toListId: 'L', listCardIds: list, placement: 'bottom' })
    ).toEqual([
      { type: 'card.move', id: 'a', toListId: 'L' },
      { type: 'card.move', id: 'b', toListId: 'L' }
    ])
  })

  it('top: the first goes above the first card, the rest follow it', () => {
    expect(
      transferMutations({ mode: 'move', cardIds: ['a', 'b'], toListId: 'L', listCardIds: list, placement: 'top' })
    ).toEqual([
      { type: 'card.move', id: 'a', toListId: 'L', afterId: 'x' },
      { type: 'card.move', id: 'b', toListId: 'L', beforeId: 'a' }
    ])
  })

  it('top skips cards that are themselves moving (a move within the same list)', () => {
    expect(
      transferMutations({ mode: 'move', cardIds: ['x'], toListId: 'L', listCardIds: list, placement: 'top' })
    ).toEqual([{ type: 'card.move', id: 'x', toListId: 'L', afterId: 'y' }])
  })

  it('top of an empty list has no neighbour', () => {
    expect(
      transferMutations({ mode: 'move', cardIds: ['a'], toListId: 'L', listCardIds: [], placement: 'top' })
    ).toEqual([{ type: 'card.move', id: 'a', toListId: 'L', afterId: null }])
  })

  it('copy carries the new title only when given', () => {
    expect(
      transferMutations({ mode: 'copy', cardIds: ['a'], toListId: 'L', listCardIds: list, placement: 'bottom', title: 'New' })
    ).toEqual([{ type: 'card.copy', id: 'a', toListId: 'L', title: 'New' }])
    expect(
      transferMutations({ mode: 'copy', cardIds: ['a'], toListId: 'L', listCardIds: list, placement: 'bottom' })
    ).toEqual([{ type: 'card.copy', id: 'a', toListId: 'L' }])
  })
})

function summary(id: string, name: string, over: Partial<BoardSummary> = {}): BoardSummary {
  return {
    id,
    projectId: 'p1',
    name,
    description: null,
    color: null,
    background: null,
    archived: false,
    pinned: false,
    position: id,
    listCount: 1,
    cardCount: 1,
    createdAt: 0,
    updatedAt: 0,
    ...over
  }
}

function card(id: string, title: string): CardView {
  return {
    id,
    number: 1,
    boardId: 'b1',
    title,
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
    repeat: null
  }
}

function view(
  boardId: string,
  lists: { id: string; name: string; cards: CardView[]; sortMode?: 'title-asc'; closed?: boolean }[]
): BoardView {
  return {
    project: { id: 'p1', name: 'Sample' },
    board: { id: boardId, name: boardId, color: null, background: null, swimlaneMode: null },
    labels: [],
    lists: lists.map((l, i) => ({
      id: l.id,
      name: l.name,
      color: null,
      closed: l.closed ?? false,
      position: String(i),
      wipLimit: null,
      sortMode: l.sortMode ?? null,
      onEnter: null,
      cardDensity: null,
      visibleCardLimit: null,
      cards: l.cards
    }))
  }
}

function setupBoards() {
  const k = kanbiniMock()
  k.listBoards.mockResolvedValue([
    summary('b1', 'Home'),
    summary('b2', 'Work'),
    summary('b3', 'Old', { archived: true })
  ])
  k.getBoardView.mockImplementation(async (id?: string) =>
    id === 'b2'
      ? view('b2', [
          { id: 'w-inbox', name: 'Inbox', cards: [card('w1', 'Existing')] },
          { id: 'w-sorted', name: 'Sorted', cards: [], sortMode: 'title-asc' },
          { id: 'w-closed', name: 'Closed', cards: [], closed: true }
        ])
      : view('b1', [
          { id: 'todo', name: 'Todo', cards: [card('c1', 'Pay rent')] },
          { id: 'done', name: 'Done', cards: [] }
        ])
  )
  return k
}

/** Choose a board once the boards list has loaded. */
async function pickBoard(user: ReturnType<typeof userEvent.setup>, name: string, id: string) {
  await screen.findByRole('option', { name })
  await user.selectOptions(screen.getByRole('combobox', { name: 'Board' }), id)
}

describe('<CardTransferDialog>', () => {
  it('starts on this board and the card’s list; archived boards and closed lists are left out', async () => {
    const user = userEvent.setup()
    setupBoards()
    renderWithQuery(
      <CardTransferDialog mode="move" cardIds={['c1']} sourceBoardId="b1" sourceListId="todo" onClose={vi.fn()} />
    )
    const boardSelect = await screen.findByRole('combobox', { name: 'Board' })
    await waitFor(() => expect(boardSelect).toHaveValue('b1'))
    expect(screen.getByRole('option', { name: 'Home (this board)' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Old' })).toBeNull()
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'List' })).toHaveValue('todo'))

    await pickBoard(user, 'Work', 'b2')
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'List' })).toHaveValue('w-inbox'))
    expect(screen.queryByRole('option', { name: 'Closed' })).toBeNull()
  })

  it('moves a card to the top of a list on another board, then offers to open it', async () => {
    const user = userEvent.setup()
    const k = setupBoards()
    k.mutate.mockResolvedValue({ id: 'c1', boardId: 'b2' })
    const onOpenCard = vi.fn()
    const onClose = vi.fn()
    const onDone = vi.fn()
    renderWithQuery(
      <CardTransferDialog
        mode="move"
        cardIds={['c1']}
        sourceBoardId="b1"
        sourceListId="todo"
        onClose={onClose}
        onDone={onDone}
        onOpenCard={onOpenCard}
      />
    )
    await pickBoard(user, 'Work', 'b2')
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'List' })).toHaveValue('w-inbox'))
    await user.click(screen.getByRole('radio', { name: 'Top of the list' }))
    await user.click(screen.getByRole('button', { name: 'Move' }))
    expect(k.mutate).toHaveBeenCalledWith({ type: 'card.move', id: 'c1', toListId: 'w-inbox', afterId: 'w1' })
    expect(await screen.findByRole('heading', { name: 'Moved to Work' })).toBeInTheDocument()
    expect(onDone).toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Open card' }))
    expect(onClose).toHaveBeenCalled()
    expect(onOpenCard).toHaveBeenCalledWith('b2', 'c1')
  })

  it('a move on the same board just closes', async () => {
    const user = userEvent.setup()
    const k = setupBoards()
    const onClose = vi.fn()
    renderWithQuery(
      <CardTransferDialog mode="move" cardIds={['c1']} sourceBoardId="b1" sourceListId="todo" onClose={onClose} />
    )
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'List' })).toHaveValue('todo'))
    await user.selectOptions(screen.getByRole('combobox', { name: 'List' }), 'done')
    await user.click(screen.getByRole('button', { name: 'Move' }))
    expect(k.mutate).toHaveBeenCalledWith({ type: 'card.move', id: 'c1', toListId: 'done' })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('several cards go as one batch (one undo)', async () => {
    const user = userEvent.setup()
    const k = setupBoards()
    renderWithQuery(
      <CardTransferDialog mode="move" cardIds={['c1', 'c2']} sourceBoardId="b1" sourceListId="todo" onClose={vi.fn()} />
    )
    expect(await screen.findByRole('heading', { name: 'Move 2 cards' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'List' })).toHaveValue('todo'))
    await user.selectOptions(screen.getByRole('combobox', { name: 'List' }), 'done')
    await user.click(screen.getByRole('button', { name: 'Move' }))
    expect(k.mutateBatch).toHaveBeenCalledWith([
      { type: 'card.move', id: 'c1', toListId: 'done' },
      { type: 'card.move', id: 'c2', toListId: 'done' }
    ])
    expect(k.mutate).not.toHaveBeenCalled()
  })

  it('copy: editable title, sent only when changed, and a sorted list explains the position', async () => {
    const user = userEvent.setup()
    const k = setupBoards()
    renderWithQuery(
      <CardTransferDialog
        mode="copy"
        cardIds={['c1']}
        sourceBoardId="b1"
        sourceListId="todo"
        sourceTitle="Pay rent"
        onClose={vi.fn()}
      />
    )
    const titleInput = await screen.findByRole('textbox', { name: 'Title' })
    expect(titleInput).toHaveValue('Pay rent')
    await pickBoard(user, 'Work', 'b2')
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'List' })).toHaveValue('w-inbox'))
    await user.selectOptions(screen.getByRole('combobox', { name: 'List' }), 'w-sorted')
    expect(screen.getByText(/This list sorts its cards/)).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: 'Top of the list' })).toBeNull()

    await user.clear(titleInput)
    expect(screen.getByRole('button', { name: 'Copy' })).toBeDisabled()
    await user.type(titleInput, 'Pay rent (June)')
    await user.click(screen.getByRole('button', { name: 'Copy' }))
    expect(k.mutate).toHaveBeenCalledWith({
      type: 'card.copy',
      id: 'c1',
      toListId: 'w-sorted',
      title: 'Pay rent (June)'
    })
    expect(await screen.findByRole('heading', { name: 'Copied to Work' })).toBeInTheDocument()
  })

  it('shows the error and stays open when the move fails', async () => {
    const user = userEvent.setup()
    const k = setupBoards()
    k.mutate.mockRejectedValueOnce(new Error('list gone'))
    const onClose = vi.fn()
    renderWithQuery(
      <CardTransferDialog mode="move" cardIds={['c1']} sourceBoardId="b1" sourceListId="todo" onClose={onClose} />
    )
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'List' })).toHaveValue('todo'))
    await user.click(screen.getByRole('button', { name: 'Move' }))
    expect(await screen.findByText('list gone')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })
})
