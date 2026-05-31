import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BoardSummary, SearchHit } from '@kanbini/shared'
import { CommandPalette } from '../command-palette'
import { renderWithQuery } from '../../__tests__/_render'
import { kanbiniMock } from '../../__tests__/_kanbini-mock'

// Behaviour tests for the M4-D command palette. The palette is the
// app's only keyboard-first input surface - the matrix worth covering:
//   - Empty query lists every board, with "Jump to board" header
//   - Typing fires debounced searchCards + renders the hits
//   - Up/Down navigate, Enter activates the selected item
//   - Clicking a hit fires onActivate with (boardId, cardId?)
//   - keepPreviousData doesn't flicker between keystrokes

function makeBoard(overrides: Partial<BoardSummary> = {}): BoardSummary {
  return {
    id: 'b1',
    projectId: 'p1',
    name: 'Board One',
    description: null,
    color: null,
    background: null,
    archived: false,
    pinned: false,
    position: 'a',
    listCount: 1,
    cardCount: 3,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}
function makeHit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    cardId: 'c1',
    title: 'A card',
    descriptionSnippet: null,
    boardId: 'b1',
    boardName: 'Board One',
    listName: 'Todo',
    matchedLabels: [],
    matchKind: 'title',
    updatedAt: 0,
    ...overrides
  }
}

describe('<CommandPalette>', () => {
  it('renders nothing when closed', () => {
    const { container } = renderWithQuery(
      <CommandPalette open={false} onClose={vi.fn()} boards={[]} onActivate={vi.fn()} />
    )
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('shows every non-archived board with an empty query', async () => {
    const boards = [
      makeBoard({ id: 'b1', name: 'Active board' }),
      makeBoard({ id: 'b2', name: 'Hidden board', archived: true }),
      makeBoard({ id: 'b3', name: 'Another active' })
    ]
    renderWithQuery(
      <CommandPalette
        open
        onClose={vi.fn()}
        boards={boards}
        onActivate={vi.fn()}
      />
    )
    expect(await screen.findByText('Active board')).toBeInTheDocument()
    expect(screen.getByText('Another active')).toBeInTheDocument()
    expect(screen.queryByText('Hidden board')).toBeNull()
    expect(screen.getByText(/jump to board/i)).toBeInTheDocument()
  })

  it('fires searchCards after typing + renders the hits', async () => {
    const user = userEvent.setup()
    kanbiniMock().searchCards.mockResolvedValue([
      makeHit({ cardId: 'c1', title: 'fix the dragon' }),
      makeHit({ cardId: 'c2', title: 'draft the docs' })
    ])
    renderWithQuery(
      <CommandPalette open onClose={vi.fn()} boards={[]} onActivate={vi.fn()} />
    )
    // Type into the search input (autofocused via queueMicrotask).
    const input = await screen.findByPlaceholderText(/search cards/i)
    await user.type(input, 'dra')
    await waitFor(() => {
      expect(kanbiniMock().searchCards).toHaveBeenCalled()
    })
    // Debounced - the IPC is called with the trimmed final value.
    expect(kanbiniMock().searchCards).toHaveBeenLastCalledWith({
      query: 'dra',
      limit: 50
    })
    expect(await screen.findByText('fix the dragon')).toBeInTheDocument()
    expect(await screen.findByText('draft the docs')).toBeInTheDocument()
    expect(screen.getByText(/^cards$/i)).toBeInTheDocument()
  })

  it('clicking a card hit calls onActivate(boardId, cardId) + onClose', async () => {
    const user = userEvent.setup()
    kanbiniMock().searchCards.mockResolvedValue([
      makeHit({ cardId: 'c1', title: 'click me', boardId: 'b-target' })
    ])
    const onActivate = vi.fn()
    const onClose = vi.fn()
    renderWithQuery(
      <CommandPalette
        open
        onClose={onClose}
        boards={[]}
        onActivate={onActivate}
      />
    )
    const input = await screen.findByPlaceholderText(/search cards/i)
    await user.type(input, 'click')
    const hit = await screen.findByText('click me')
    await user.click(hit)
    expect(onActivate).toHaveBeenCalledWith('b-target', 'c1')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('clicking a board row calls onActivate(boardId) without cardId', async () => {
    const user = userEvent.setup()
    const onActivate = vi.fn()
    renderWithQuery(
      <CommandPalette
        open
        onClose={vi.fn()}
        boards={[makeBoard({ id: 'b-go', name: 'Jump target' })]}
        onActivate={onActivate}
      />
    )
    const row = await screen.findByText('Jump target')
    await user.click(row)
    expect(onActivate).toHaveBeenCalledWith('b-go')
    // No second arg - undefined.
    expect(onActivate.mock.calls[0]).toHaveLength(1)
  })

  it('Enter activates the selected row (Down then Enter)', async () => {
    const user = userEvent.setup()
    const onActivate = vi.fn()
    renderWithQuery(
      <CommandPalette
        open
        onClose={vi.fn()}
        boards={[
          makeBoard({ id: 'b1', name: 'First' }),
          makeBoard({ id: 'b2', name: 'Second' })
        ]}
        onActivate={onActivate}
      />
    )
    const input = await screen.findByPlaceholderText(/search cards/i)
    // First row is selected by default → Down moves to second.
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Enter}')
    expect(onActivate).toHaveBeenCalledWith('b2')
    expect(input).toBeInTheDocument()
  })

  it('ArrowUp from index 0 wraps to the last row', async () => {
    const user = userEvent.setup()
    const onActivate = vi.fn()
    renderWithQuery(
      <CommandPalette
        open
        onClose={vi.fn()}
        boards={[
          makeBoard({ id: 'b1', name: 'First' }),
          makeBoard({ id: 'b2', name: 'Second' }),
          makeBoard({ id: 'b3', name: 'Third' })
        ]}
        onActivate={onActivate}
      />
    )
    await screen.findByPlaceholderText(/search cards/i)
    await user.keyboard('{ArrowUp}{Enter}')
    expect(onActivate).toHaveBeenCalledWith('b3')
  })

  it('shows the no-matches message when a query has zero hits', async () => {
    const user = userEvent.setup()
    kanbiniMock().searchCards.mockResolvedValue([])
    renderWithQuery(
      <CommandPalette
        open
        onClose={vi.fn()}
        boards={[]}
        onActivate={vi.fn()}
      />
    )
    const input = await screen.findByPlaceholderText(/search cards/i)
    await user.type(input, 'zzz nothing here')
    expect(await screen.findByText(/no matches/i)).toBeInTheDocument()
  })

  it('shows "No boards yet." when the empty palette has no boards', async () => {
    renderWithQuery(
      <CommandPalette
        open
        onClose={vi.fn()}
        boards={[]}
        onActivate={vi.fn()}
      />
    )
    expect(await screen.findByText(/no boards yet/i)).toBeInTheDocument()
  })
})
