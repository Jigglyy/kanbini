import { describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
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
    number: 1,
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

/** Result rows' text, top to bottom. */
const rowTexts = (): string[] =>
  Array.from(document.querySelectorAll('[data-row]')).map((r) => r.textContent ?? '')
/** Text of the selected row (the one Enter takes). */
const activeRowText = (): string =>
  document.querySelector('[data-row][aria-current="true"]')?.textContent ?? ''

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

  it("shows each card hit's #number", async () => {
    const user = userEvent.setup()
    kanbiniMock().searchCards.mockResolvedValue([
      makeHit({ cardId: 'c7', number: 142, title: 'Fix login', matchKind: 'number' })
    ])
    renderWithQuery(
      <CommandPalette open onClose={vi.fn()} boards={[]} onActivate={vi.fn()} />
    )
    const input = await screen.findByPlaceholderText(/search cards/i)
    await user.type(input, '#142')
    expect(await screen.findByText('Fix login')).toBeInTheDocument()
    expect(screen.getByText('#142')).toBeInTheDocument()
  })

  it('asks search to put the on-screen board first, and keeps that order', async () => {
    const user = userEvent.setup()
    // Search (given preferBoardId) returns this board's hit first, even a
    // description match ahead of another board's exact #67.
    const mock = kanbiniMock()
    mock.searchCards.mockResolvedValue([
      makeHit({ cardId: 'c-here', number: 194, title: 'Here', boardId: 'b1', matchKind: 'description' }),
      makeHit({ cardId: 'c-other', number: 67, title: 'Elsewhere', boardId: 'b2', matchKind: 'number' })
    ])
    const onActivate = vi.fn()
    renderWithQuery(
      <CommandPalette open onClose={vi.fn()} boards={[]} currentBoardId="b1" onActivate={onActivate} />
    )
    await user.type(await screen.findByPlaceholderText(/search cards/i), '67')
    expect(await screen.findByText('Here')).toBeInTheDocument()
    expect(mock.searchCards).toHaveBeenLastCalledWith({
      query: '67',
      limit: 50,
      preferBoardId: 'b1'
    })
    // The row on top is the one Enter takes (they used to differ: the
    // rows rendered in search order, Enter used a re-sorted list).
    expect(rowTexts()[0]).toContain('Here')
    await user.keyboard('{Enter}')
    expect(onActivate).toHaveBeenCalledWith('b1', 'c-here')
  })

  it('marks the selected row, and every new search starts on the first result', async () => {
    const user = userEvent.setup()
    kanbiniMock().searchCards.mockImplementation(async ({ query }) =>
      query === 'a'
        ? [makeHit({ cardId: 'a1', title: 'a one' }), makeHit({ cardId: 'a2', title: 'a two' })]
        : [makeHit({ cardId: 'b1', title: 'ab one' }), makeHit({ cardId: 'b2', title: 'ab two' })]
    )
    const onActivate = vi.fn()
    renderWithQuery(
      <CommandPalette open onClose={vi.fn()} boards={[]} onActivate={onActivate} />
    )
    const input = await screen.findByPlaceholderText(/search cards/i)
    await user.type(input, 'a')
    await screen.findByText('a two')
    await user.keyboard('{ArrowDown}')
    expect(activeRowText()).toContain('a two')

    await user.type(input, 'b')
    await screen.findByText('ab two')
    await waitFor(() => expect(activeRowText()).toContain('ab one'))
    await user.keyboard('{Enter}')
    expect(onActivate).toHaveBeenCalledWith('b1', 'b1')
  })

  // Typing "192" and hitting Enter at once used to act on whatever the
  // previous (debounced) search had shown - even the empty search's board
  // list - so it landed on a random board or card.
  it('Enter pressed before the results for what you typed arrive waits for them', async () => {
    const user = userEvent.setup()
    kanbiniMock().searchCards.mockImplementation(async ({ query }) =>
      query === '192'
        ? [makeHit({ cardId: 'c192', number: 192, title: 'The 192 card', boardId: 'b-dice', matchKind: 'number' })]
        : [makeHit({ cardId: 'c-stale', title: 'Stale hit', boardId: 'b-other' })]
    )
    const onActivate = vi.fn()
    renderWithQuery(
      <CommandPalette
        open
        onClose={vi.fn()}
        boards={[makeBoard({ id: 'b-landlord', name: 'Landlord' })]}
        onActivate={onActivate}
      />
    )
    const input = await screen.findByPlaceholderText(/search cards/i)
    await user.type(input, '192{Enter}')
    await waitFor(() => expect(onActivate).toHaveBeenCalled())
    expect(onActivate).toHaveBeenCalledTimes(1)
    expect(onActivate).toHaveBeenCalledWith('b-dice', 'c192')
  })

  it('Ctrl+Enter and Ctrl+click open the card instead of showing it', async () => {
    const user = userEvent.setup()
    kanbiniMock().searchCards.mockResolvedValue([
      makeHit({ cardId: 'c1', title: 'open me', boardId: 'b-t' })
    ])
    const onActivate = vi.fn()
    renderWithQuery(
      <CommandPalette open onClose={vi.fn()} boards={[]} onActivate={onActivate} />
    )
    await user.type(await screen.findByPlaceholderText(/search cards/i), 'open')
    await screen.findByText('open me')
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(onActivate).toHaveBeenLastCalledWith('b-t', 'c1', { open: true })
    await user.keyboard('{Control>}')
    await user.click(screen.getByText('open me'))
    await user.keyboard('{/Control}')
    expect(onActivate).toHaveBeenLastCalledWith('b-t', 'c1', { open: true })
  })

  it('tells you which keys do what', async () => {
    const user = userEvent.setup()
    kanbiniMock().searchCards.mockResolvedValue([makeHit({ title: 'hint me' })])
    renderWithQuery(
      <CommandPalette open onClose={vi.fn()} boards={[]} onActivate={vi.fn()} />
    )
    await user.type(await screen.findByPlaceholderText(/search cards/i), 'hint')
    await screen.findByText('hint me')
    expect(screen.getByText(/to show it on the board/i)).toBeInTheDocument()
    expect(screen.getByText(/to open it/i)).toBeInTheDocument()
  })

  describe('the mouse', () => {
    const threeBoards = [
      makeBoard({ id: 'b1', name: 'First' }),
      makeBoard({ id: 'b2', name: 'Second' }),
      makeBoard({ id: 'b3', name: 'Third' })
    ]

    // Rows that render under a resting mouse get mouseenter / a
    // mousemove at the same spot - that used to select them, so Enter
    // took whatever row appeared under the pointer.
    it('a row appearing under a resting mouse does not take the selection', async () => {
      const user = userEvent.setup()
      const onActivate = vi.fn()
      renderWithQuery(
        <CommandPalette open onClose={vi.fn()} boards={threeBoards} onActivate={onActivate} />
      )
      const third = (await screen.findByText('Third')).closest('button')!
      fireEvent.mouseEnter(third)
      fireEvent.mouseMove(third, { clientX: 40, clientY: 90 })
      fireEvent.mouseMove(third, { clientX: 40, clientY: 90 })
      expect(activeRowText()).toContain('First')
      await user.keyboard('{Enter}')
      expect(onActivate).toHaveBeenCalledWith('b1')
    })

    it('moving the mouse over a row selects it', async () => {
      const user = userEvent.setup()
      const onActivate = vi.fn()
      renderWithQuery(
        <CommandPalette open onClose={vi.fn()} boards={threeBoards} onActivate={onActivate} />
      )
      const third = (await screen.findByText('Third')).closest('button')!
      fireEvent.mouseMove(third, { clientX: 40, clientY: 90 })
      fireEvent.mouseMove(third, { clientX: 42, clientY: 91 })
      expect(activeRowText()).toContain('Third')
      await user.keyboard('{Enter}')
      expect(onActivate).toHaveBeenCalledWith('b3')
    })

    it('a nudge of the mouse on the same row does not undo arrowing away', async () => {
      const user = userEvent.setup()
      renderWithQuery(
        <CommandPalette open onClose={vi.fn()} boards={threeBoards} onActivate={vi.fn()} />
      )
      const third = (await screen.findByText('Third')).closest('button')!
      fireEvent.mouseMove(third, { clientX: 40, clientY: 90 })
      fireEvent.mouseMove(third, { clientX: 42, clientY: 91 })
      await user.keyboard('{ArrowUp}')
      expect(activeRowText()).toContain('Second')
      fireEvent.mouseMove(third, { clientX: 43, clientY: 91 })
      expect(activeRowText()).toContain('Second')
    })
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
