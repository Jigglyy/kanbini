import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ArchivedItemsView } from '@kanbini/shared'
import { ArchivedItemsDialog } from '../archived-items'
import { renderWithQuery } from '../../__tests__/_render'
import { kanbiniMock } from '../../__tests__/_kanbini-mock'

// The board's Archived view: archived cards + closed lists, each with
// Restore and Delete (Delete asks first). Restoring a card whose list is
// closed too reopens the list in the same change, or it'd stay hidden.

const VIEW: ArchivedItemsView = {
  boardId: 'b1',
  lists: [{ id: 'l-old', name: 'Old ideas', color: 'red', cardCount: 2 }],
  cards: [
    {
      id: 'c1',
      title: 'Fix login',
      listId: 'l-todo',
      listName: 'To Do',
      listClosed: false,
      updatedAt: 2
    },
    {
      id: 'c2',
      title: 'Parked idea',
      listId: 'l-old',
      listName: 'Old ideas',
      listClosed: true,
      updatedAt: 1
    }
  ]
}

function renderDialog(view: ArchivedItemsView | null = VIEW) {
  const mock = kanbiniMock()
  mock.archivedItems.mockResolvedValue(view)
  renderWithQuery(
    <ArchivedItemsDialog open boardId="b1" boardName="Website" onClose={vi.fn()} />
  )
  return mock
}

const cardRow = (title: string) => screen.getByRole('listitem', { name: title })

describe('<ArchivedItemsDialog>', () => {
  it("lists the board's archived cards and closed lists", async () => {
    const mock = renderDialog()
    expect(await screen.findByRole('dialog', { name: 'Archived on Website' })).toBeInTheDocument()
    expect(mock.archivedItems).toHaveBeenCalledWith({ boardId: 'b1' })
    expect(await screen.findByText('Fix login')).toBeInTheDocument()
    expect(cardRow('Fix login')).toHaveTextContent('in To Do')
    // A card whose list is closed too says so.
    expect(cardRow('Parked idea')).toHaveTextContent('Old ideas (archived too)')
    expect(screen.getByRole('listitem', { name: 'Old ideas' })).toHaveTextContent('2 cards')
  })

  it('Restore puts a card back', async () => {
    const user = userEvent.setup()
    const mock = renderDialog()
    await screen.findByText('Fix login')
    await user.click(within(cardRow('Fix login')).getByRole('button', { name: 'Restore' }))
    expect(mock.mutate).toHaveBeenCalledWith({
      type: 'card.update',
      id: 'c1',
      patch: { archived: false }
    })
  })

  it('restoring a card in a closed list reopens the list in the same change', async () => {
    const user = userEvent.setup()
    const mock = renderDialog()
    await screen.findByText('Parked idea')
    await user.click(within(cardRow('Parked idea')).getByRole('button', { name: 'Restore' }))
    expect(mock.mutateBatch).toHaveBeenCalledWith([
      { type: 'list.update', id: 'l-old', patch: { closed: false } },
      { type: 'card.update', id: 'c2', patch: { archived: false } }
    ])
    expect(mock.mutate).not.toHaveBeenCalled()
  })

  it('Restore reopens a closed list', async () => {
    const user = userEvent.setup()
    const mock = renderDialog()
    const row = await screen.findByRole('listitem', { name: 'Old ideas' })
    await user.click(within(row).getByRole('button', { name: 'Restore' }))
    expect(mock.mutate).toHaveBeenCalledWith({
      type: 'list.update',
      id: 'l-old',
      patch: { closed: false }
    })
  })

  it('Delete asks first; Cancel backs out, Delete deletes', async () => {
    const user = userEvent.setup()
    const mock = renderDialog()
    await screen.findByText('Fix login')
    const row = cardRow('Fix login')
    await user.click(within(row).getByRole('button', { name: 'Delete' }))
    expect(row).toHaveTextContent('Delete “Fix login”? You can undo this with Ctrl+Z.')
    await user.click(within(row).getByRole('button', { name: 'Cancel' }))
    expect(mock.mutate).not.toHaveBeenCalled()
    await user.click(within(row).getByRole('button', { name: 'Delete' }))
    await user.click(within(row).getByRole('button', { name: 'Delete' }))
    expect(mock.mutate).toHaveBeenCalledWith({ type: 'card.delete', id: 'c1' })
  })

  it('deleting a closed list says how many cards go with it', async () => {
    const user = userEvent.setup()
    const mock = renderDialog()
    const row = await screen.findByRole('listitem', { name: 'Old ideas' })
    await user.click(within(row).getByRole('button', { name: 'Delete' }))
    expect(row).toHaveTextContent('Delete “Old ideas” and its 2 cards?')
    await user.click(within(row).getByRole('button', { name: 'Delete' }))
    expect(mock.mutate).toHaveBeenCalledWith({ type: 'list.delete', id: 'l-old' })
  })

  it('says so when nothing is archived', async () => {
    renderDialog({ boardId: 'b1', lists: [], cards: [] })
    await waitFor(() =>
      expect(screen.getByText(/nothing is archived on this board/i)).toBeInTheDocument()
    )
  })
})
