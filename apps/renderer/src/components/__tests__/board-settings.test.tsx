import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { BoardView, Mutation } from '@kanbini/shared'
import { BoardSettings } from '../board-settings'

// Tests for the board-rename popover + the surfaces it hosts above
// itself (background picker, save-as-template). Three responsibilities
// share the popover today:
//   - rename (single input, commit on Enter / blur)
//   - "Background…" → opens BackgroundPicker (a separate modal)
//   - "Save as template…" → opens SaveTemplateDialog
//   - swimlane grouping (None / Priority chips)

function makeBoard(overrides: Partial<BoardView['board']> = {}): BoardView {
  return {
    project: { id: 'p1', name: 'Sample' },
    board: {
      id: 'b1',
      name: 'Welcome',
      color: null,
      background: null,
      swimlaneMode: null,
      ...overrides
    },
    labels: [],
    lists: []
  }
}

function renderBoardSettings(
  board: BoardView,
  apply: (m: Mutation, o: unknown) => void = vi.fn()
) {
  // SaveTemplateDialog uses TanStack mutations + queries via the
  // shared QueryClientProvider - wrap to avoid the "no provider" throw.
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } }
  })
  return render(
    <QueryClientProvider client={qc}>
      <BoardSettings board={board} apply={apply} />
    </QueryClientProvider>
  )
}

describe('<BoardSettings>', () => {
  it('renders a pencil trigger button (closed by default)', () => {
    renderBoardSettings(makeBoard())
    expect(
      screen.getByRole('button', { name: 'Rename board' })
    ).toBeInTheDocument()
    // Body is not in the DOM until the popover opens.
    expect(screen.queryByDisplayValue('Welcome')).toBeNull()
  })

  it('opens the popover with the board name pre-filled', async () => {
    const user = userEvent.setup()
    renderBoardSettings(makeBoard())
    await user.click(screen.getByRole('button', { name: 'Rename board' }))
    expect(screen.getByDisplayValue('Welcome')).toBeInTheDocument()
  })

  it('rename via blur commits board.update with the trimmed new name', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    renderBoardSettings(makeBoard(), apply)
    await user.click(screen.getByRole('button', { name: 'Rename board' }))
    const input = screen.getByDisplayValue('Welcome')
    fireEvent.change(input, { target: { value: '  Renamed  ' } })
    fireEvent.blur(input)
    expect(apply.mock.calls[0]![0]).toEqual({
      type: 'board.update',
      id: 'b1',
      patch: { name: 'Renamed' }
    })
  })

  it('rename no-ops when the trimmed value matches the current name', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    renderBoardSettings(makeBoard(), apply)
    await user.click(screen.getByRole('button', { name: 'Rename board' }))
    const input = screen.getByDisplayValue('Welcome')
    fireEvent.change(input, { target: { value: '   Welcome   ' } })
    fireEvent.blur(input)
    expect(apply).not.toHaveBeenCalled()
  })

  it('rename no-ops when the trimmed value is empty', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    renderBoardSettings(makeBoard(), apply)
    await user.click(screen.getByRole('button', { name: 'Rename board' }))
    const input = screen.getByDisplayValue('Welcome')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.blur(input)
    expect(apply).not.toHaveBeenCalled()
  })

  it('Enter blurs/commits the rename via the focus shift', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    renderBoardSettings(makeBoard(), apply)
    await user.click(screen.getByRole('button', { name: 'Rename board' }))
    const input = screen.getByDisplayValue('Welcome')
    fireEvent.change(input, { target: { value: 'New name' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    // Enter triggers close() which unmounts the input + fires blur,
    // which runs the rename.
    expect(apply.mock.calls[0]![0]).toEqual({
      type: 'board.update',
      id: 'b1',
      patch: { name: 'New name' }
    })
  })

  it('Background… opens the BackgroundPicker modal', async () => {
    const user = userEvent.setup()
    renderBoardSettings(makeBoard())
    await user.click(screen.getByRole('button', { name: 'Rename board' }))
    await user.click(screen.getByRole('button', { name: /background/i }))
    // BackgroundPicker renders an H2 "Board background" inside its
    // Modal - assert that to confirm the modal opened.
    expect(
      screen.getByRole('heading', { name: 'Board background' })
    ).toBeInTheDocument()
  })

  it('Save as template… opens the SaveTemplateDialog with the board name pre-filled', async () => {
    const user = userEvent.setup()
    renderBoardSettings(makeBoard())
    await user.click(screen.getByRole('button', { name: 'Rename board' }))
    await user.click(
      screen.getByRole('button', { name: /save as template/i })
    )
    // The SaveTemplateDialog uses an h2 "Save board as template".
    expect(
      screen.getByRole('heading', { name: /save board as template/i })
    ).toBeInTheDocument()
    expect(screen.getByDisplayValue('Welcome')).toBeInTheDocument()
  })

  it('Group by chip "Priority" fires board.update with swimlaneMode: priority', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    renderBoardSettings(makeBoard(), apply)
    await user.click(screen.getByRole('button', { name: 'Rename board' }))
    await user.click(screen.getByRole('button', { name: 'Priority' }))
    expect(apply.mock.calls[0]![0]).toEqual({
      type: 'board.update',
      id: 'b1',
      patch: { swimlaneMode: 'priority' }
    })
  })

  it('Group by chip "None" reverts swimlaneMode to null', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    renderBoardSettings(makeBoard({ swimlaneMode: 'priority' }), apply)
    await user.click(screen.getByRole('button', { name: 'Rename board' }))
    await user.click(screen.getByRole('button', { name: 'None' }))
    expect(apply.mock.calls[0]![0]).toEqual({
      type: 'board.update',
      id: 'b1',
      patch: { swimlaneMode: null }
    })
  })

  it("clicking the already-active swimlane chip is a no-op (doesn't fire apply)", async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    renderBoardSettings(makeBoard({ swimlaneMode: 'priority' }), apply)
    await user.click(screen.getByRole('button', { name: 'Rename board' }))
    await user.click(screen.getByRole('button', { name: 'Priority' }))
    expect(apply).not.toHaveBeenCalled()
  })

  it("re-syncs the input while the popover is open if the board is renamed externally", async () => {
    const user = userEvent.setup()
    const { rerender } = renderBoardSettings(makeBoard())
    await user.click(screen.getByRole('button', { name: 'Rename board' }))
    expect(screen.getByDisplayValue('Welcome')).toBeInTheDocument()
    // Simulate another window renaming the board while this popover
    // is open. Same root → useEffect fires on the board name change.
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } }
    })
    rerender(
      <QueryClientProvider client={qc}>
        <BoardSettings
          board={makeBoard({ name: 'Renamed externally' })}
          apply={vi.fn()}
        />
      </QueryClientProvider>
    )
    expect(
      screen.getByDisplayValue('Renamed externally')
    ).toBeInTheDocument()
  })
})
