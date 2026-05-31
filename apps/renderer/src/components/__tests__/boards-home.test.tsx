import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { BoardSummary } from '@kanbini/shared'
import { BoardsHome } from '../boards-home'
import { kanbiniMock } from '../../__tests__/_kanbini-mock'

// Tests for the boards-home shell - filter / sort / archive toggle /
// empty states / Trello import + New board / From template dialogs.
// DnD reorder is exercised when sortMode is 'manual' AND the filter
// is empty; switching to any non-default sort or typing in the filter
// skips the <DndContext> path entirely. The tests here drive the
// non-DnD code paths so we don't need dnd-kit testing-utils. The
// pure DnD helpers (listOf / laneOf) have their own test file in
// lib/__tests__/board-dnd.test.ts.

function makeBoard(overrides: Partial<BoardSummary> = {}): BoardSummary {
  return {
    id: 'b1',
    projectId: 'p1',
    name: 'Welcome',
    description: null,
    color: null,
    background: null,
    archived: false,
    pinned: false,
    position: 'a',
    listCount: 1,
    cardCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides
  }
}

function renderBoardsHome(
  boards: BoardSummary[],
  onOpen: (id: string) => void = vi.fn()
) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } }
  })
  return render(
    <QueryClientProvider client={qc}>
      <BoardsHome boards={boards} onOpen={onOpen} />
    </QueryClientProvider>
  )
}

describe('<BoardsHome> empty state', () => {
  it('renders the empty state when no boards exist', () => {
    renderBoardsHome([])
    // EmptyState shows a primary "Create your first board" button.
    expect(
      screen.getByRole('button', { name: /create your first board/i })
    ).toBeInTheDocument()
  })

  it('clicking the empty-state CTA opens the New board dialog', async () => {
    const user = userEvent.setup()
    renderBoardsHome([])
    await user.click(
      screen.getByRole('button', { name: /create your first board/i })
    )
    expect(
      screen.getByRole('heading', { name: /new board/i })
    ).toBeInTheDocument()
  })
})

describe('<BoardsHome> header buttons', () => {
  it('renders the three primary header buttons', () => {
    renderBoardsHome([makeBoard()])
    expect(
      screen.getByRole('button', { name: /import from trello/i })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /from template/i })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /^new board$/i })
    ).toBeInTheDocument()
  })

  it('"New board" opens the NewBoardDialog', async () => {
    const user = userEvent.setup()
    renderBoardsHome([makeBoard()])
    await user.click(screen.getByRole('button', { name: /^new board$/i }))
    expect(
      screen.getByRole('heading', { name: /new board/i })
    ).toBeInTheDocument()
  })

  it('Import from Trello surfaces a returned summary via onOpen', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    const mock = kanbiniMock()
    mock.importTrello.mockResolvedValueOnce({
      boardId: 'imported-board',
      boardName: 'Imported',
      counts: {
        lists: 3,
        cards: 7,
        labels: 2,
        cardLabels: 0,
        checklists: 0,
        checklistItems: 0
      },
      skipped: { attachments: 0, cards: 0, checklists: 0 }
    })
    renderBoardsHome([makeBoard()], onOpen)
    await user.click(
      screen.getByRole('button', { name: /import from trello/i })
    )
    await waitFor(() => {
      expect(onOpen).toHaveBeenCalledWith('imported-board')
    })
  })

  it('Import from Trello surfaces an error message inline', async () => {
    const user = userEvent.setup()
    const mock = kanbiniMock()
    mock.importTrello.mockRejectedValueOnce(
      new Error('That file isn\'t valid JSON.')
    )
    renderBoardsHome([makeBoard()])
    await user.click(
      screen.getByRole('button', { name: /import from trello/i })
    )
    expect(
      await screen.findByText(/isn't valid JSON/i)
    ).toBeInTheDocument()
  })

  it('Import from Trello stays quiet when the user cancels (null result)', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    const mock = kanbiniMock()
    mock.importTrello.mockResolvedValueOnce(null)
    renderBoardsHome([makeBoard()], onOpen)
    await user.click(
      screen.getByRole('button', { name: /import from trello/i })
    )
    await waitFor(() => {
      expect(mock.importTrello).toHaveBeenCalled()
    })
    expect(onOpen).not.toHaveBeenCalled()
    // No error banner either.
    expect(screen.queryByText(/import/i)).not.toHaveClass('bg-red-500/10')
  })
})

describe('<BoardsHome> filter', () => {
  it('search filters the board list by name (case-insensitive)', async () => {
    const user = userEvent.setup()
    renderBoardsHome([
      makeBoard({ id: 'b1', name: 'Welcome' }),
      makeBoard({ id: 'b2', name: 'Personal' }),
      makeBoard({ id: 'b3', name: 'Work' })
    ])
    const input = screen.getByPlaceholderText(/filter boards/i)
    await user.type(input, 'wor')
    // The visible boards link/heading renders each name; check that
    // Work is shown + Welcome/Personal are not.
    expect(screen.getByText('Work')).toBeInTheDocument()
    expect(screen.queryByText('Welcome')).toBeNull()
    expect(screen.queryByText('Personal')).toBeNull()
  })

  it('search filters by description (case-insensitive)', async () => {
    const user = userEvent.setup()
    renderBoardsHome([
      makeBoard({
        id: 'b1',
        name: 'Welcome',
        description: 'Onboarding tour'
      }),
      makeBoard({ id: 'b2', name: 'Personal', description: 'House chores' })
    ])
    const input = screen.getByPlaceholderText(/filter boards/i)
    await user.type(input, 'ChoREs')
    expect(screen.getByText('Personal')).toBeInTheDocument()
    expect(screen.queryByText('Welcome')).toBeNull()
  })

  it('no-match query renders the "No boards match" hint', async () => {
    const user = userEvent.setup()
    renderBoardsHome([makeBoard({ name: 'Welcome' })])
    await user.type(
      screen.getByPlaceholderText(/filter boards/i),
      'zzz-no-match'
    )
    expect(screen.getByText(/no boards match/i)).toBeInTheDocument()
  })
})

describe('<BoardsHome> sort', () => {
  it('sorts by name when "Name (A→Z)" is picked', async () => {
    const user = userEvent.setup()
    renderBoardsHome([
      makeBoard({ id: 'b1', name: 'Zebra' }),
      makeBoard({ id: 'b2', name: 'Apple' }),
      makeBoard({ id: 'b3', name: 'Mango' })
    ])
    await user.selectOptions(
      screen.getByLabelText(/sort/i),
      'Name (A→Z)'
    )
    // Pull the rendered order by walking the headings in document order.
    const names = screen
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent)
    expect(names).toEqual(['Apple', 'Mango', 'Zebra'])
  })

  it('sorts by Recently updated (newest first)', async () => {
    const user = userEvent.setup()
    renderBoardsHome([
      makeBoard({ id: 'b1', name: 'Old', updatedAt: 1000 }),
      makeBoard({ id: 'b2', name: 'Mid', updatedAt: 5000 }),
      makeBoard({ id: 'b3', name: 'New', updatedAt: 9000 })
    ])
    await user.selectOptions(
      screen.getByLabelText(/sort/i),
      'Recently updated'
    )
    const names = screen
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent)
    expect(names).toEqual(['New', 'Mid', 'Old'])
  })

  it('sorts by Newest first (createdAt desc)', async () => {
    const user = userEvent.setup()
    renderBoardsHome([
      makeBoard({ id: 'b1', name: 'First', createdAt: 1000 }),
      makeBoard({ id: 'b2', name: 'Second', createdAt: 2000 })
    ])
    await user.selectOptions(screen.getByLabelText(/sort/i), 'Newest first')
    const names = screen
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent)
    expect(names).toEqual(['Second', 'First'])
  })

  it('pinned boards always sort above unpinned, regardless of sort mode', async () => {
    const user = userEvent.setup()
    renderBoardsHome([
      makeBoard({ id: 'b1', name: 'Zebra', pinned: true, createdAt: 1000 }),
      makeBoard({ id: 'b2', name: 'Apple', pinned: false, createdAt: 9000 })
    ])
    await user.selectOptions(screen.getByLabelText(/sort/i), 'Name (A→Z)')
    const names = screen
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent)
    // Zebra is pinned → comes first even though Apple sorts earlier.
    expect(names).toEqual(['Zebra', 'Apple'])
  })

  it('persists the selected sort mode to localStorage', async () => {
    const user = userEvent.setup()
    renderBoardsHome([makeBoard()])
    await user.selectOptions(
      screen.getByLabelText(/sort/i),
      'Recently updated'
    )
    expect(window.localStorage.getItem('kanbini.boardsHomeSort')).toBe(
      'recent'
    )
  })

  it('restores the persisted sort mode on next mount', () => {
    window.localStorage.setItem('kanbini.boardsHomeSort', 'name')
    renderBoardsHome([
      makeBoard({ id: 'b1', name: 'Zebra' }),
      makeBoard({ id: 'b2', name: 'Apple' })
    ])
    // Selected option reflects the persisted value.
    expect(
      (screen.getByLabelText(/sort/i) as HTMLSelectElement).value
    ).toBe('name')
    // And the visible order is name-sorted.
    const names = screen
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent)
    expect(names).toEqual(['Apple', 'Zebra'])
  })

  it('falls back to manual when the persisted mode is unknown', () => {
    window.localStorage.setItem(
      'kanbini.boardsHomeSort',
      'invented-future-mode'
    )
    renderBoardsHome([makeBoard()])
    expect(
      (screen.getByLabelText(/sort/i) as HTMLSelectElement).value
    ).toBe('manual')
  })
})

describe('<BoardsHome> archived toggle', () => {
  it('hides the toggle when no boards are archived', () => {
    renderBoardsHome([makeBoard()])
    expect(
      screen.queryByRole('button', { name: /show archived/i })
    ).toBeNull()
  })

  it('shows the toggle + the archived count when at least one is archived', () => {
    renderBoardsHome([
      makeBoard({ id: 'b1', name: 'Active' }),
      makeBoard({ id: 'b2', name: 'Old', archived: true })
    ])
    expect(
      screen.getByRole('button', { name: /show archived \(1\)/i })
    ).toBeInTheDocument()
    // Archived board hidden by default.
    expect(screen.queryByText('Old')).toBeNull()
  })

  it('clicking the toggle reveals archived boards + flips the label', async () => {
    const user = userEvent.setup()
    renderBoardsHome([
      makeBoard({ id: 'b1', name: 'Active' }),
      makeBoard({ id: 'b2', name: 'Old', archived: true })
    ])
    await user.click(screen.getByRole('button', { name: /show archived/i }))
    expect(screen.getByText('Old')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /hide archived/i })
    ).toBeInTheDocument()
  })
})
