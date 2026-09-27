import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AgendaItem, AgendaView } from '@kanbini/shared'
import { AgendaPanel } from '../agenda'
import { EMPTY_AGENDA, kanbiniMock } from '../../__tests__/_kanbini-mock'
import { renderWithQuery } from '../../__tests__/_render'

// Boards-home Agenda panel. Covers: the empty hint, one group per
// section with its total, the collapsed summary + persisted toggle,
// "Show N more", opening a card, and complete / reopen from a row.

const DAY0 = new Date(2026, 8, 15).getTime()

let seq = 0
function item(over: Partial<AgendaItem> = {}): AgendaItem {
  seq += 1
  return {
    cardId: `card-${seq}`,
    title: `Card ${seq}`,
    boardId: 'b1',
    boardName: 'Work',
    boardColor: null,
    listId: 'l1',
    listName: 'Todo',
    dueAt: DAY0,
    priority: null,
    completedAt: null,
    blocked: false,
    ...over
  }
}

function agenda(over: Partial<AgendaView> = {}): AgendaView {
  const v = { ...EMPTY_AGENDA, dayStart: DAY0, ...over }
  return {
    ...v,
    totals: over.totals ?? {
      overdue: v.overdue.length,
      today: v.today.length,
      upcoming: v.upcoming.length,
      completed: v.completed.length
    }
  }
}

function renderPanel(view: AgendaView, onOpenCard = vi.fn()) {
  kanbiniMock().agenda.mockResolvedValue(view)
  renderWithQuery(<AgendaPanel onOpenCard={onOpenCard} />)
  return { onOpenCard }
}

describe('<AgendaPanel>', () => {
  it('shows a hint when nothing is due or done', async () => {
    renderPanel(agenda())
    expect(await screen.findByText(/nothing due in the next 7 days/i)).toBeInTheDocument()
    expect(kanbiniMock().agenda).toHaveBeenCalledWith({})
  })

  it('renders each section with its total and rows', async () => {
    renderPanel(
      agenda({
        overdue: [item({ title: 'Late one', dueAt: DAY0 - 86_400_000 })],
        today: [item({ title: 'Due now' }), item({ title: 'Also now' })],
        upcoming: [item({ title: 'Soon', dueAt: DAY0 + 2 * 86_400_000 })],
        completed: [item({ title: 'Finished', completedAt: Date.now() - 1000 })]
      })
    )
    const overdue = await screen.findByRole('list', { name: /overdue/i })
    expect(within(overdue).getByText('Late one')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /due today \(2\)/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /next 7 days \(1\)/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /recently completed \(1\)/i })).toBeInTheDocument()
    // Summary beside the heading.
    expect(screen.getByRole('button', { name: /agenda/i })).toHaveTextContent(
      /1 overdue.*2 today.*1 coming up.*1 done/
    )
  })

  it('collapses to the summary and remembers it', async () => {
    const user = userEvent.setup()
    renderPanel(agenda({ today: [item({ title: 'Due now' })] }))
    const toggle = await screen.findByRole('button', { name: /agenda/i })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Due now')).not.toBeInTheDocument()
    expect(localStorage.getItem('kanbini.agendaCollapsed')).toBe('1')
  })

  it('starts collapsed when that was the last choice', async () => {
    localStorage.setItem('kanbini.agendaCollapsed', '1')
    renderPanel(agenda({ today: [item({ title: 'Due now' })] }))
    const toggle = await screen.findByRole('button', { name: /agenda/i })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Due now')).not.toBeInTheDocument()
  })

  it('shows five rows per section until "Show N more"', async () => {
    const user = userEvent.setup()
    const many = Array.from({ length: 8 }, (_, i) => item({ title: `Task ${i}` }))
    renderPanel(agenda({ today: many }))
    const list = await screen.findByRole('list', { name: /due today/i })
    expect(within(list).getAllByRole('listitem')).toHaveLength(5)

    await user.click(screen.getByRole('button', { name: 'Show 3 more' }))
    expect(within(list).getAllByRole('listitem')).toHaveLength(8)
    await user.click(screen.getByRole('button', { name: 'Show less' }))
    expect(within(list).getAllByRole('listitem')).toHaveLength(5)
  })

  it('opens the card on its board when a row is clicked', async () => {
    const user = userEvent.setup()
    const { onOpenCard } = renderPanel(
      agenda({ today: [item({ cardId: 'c-42', boardId: 'b-7', title: 'Open me' })] })
    )
    await user.click(await screen.findByRole('button', { name: /open me/i }))
    expect(onOpenCard).toHaveBeenCalledWith('b-7', 'c-42')
  })

  it('completes an open card from its checkbox and refetches', async () => {
    const user = userEvent.setup()
    renderPanel(agenda({ today: [item({ cardId: 'c-1', title: 'Do it' })] }))
    const box = await screen.findByRole('checkbox', { name: /mark "do it" complete/i })
    expect(box).toHaveAttribute('aria-checked', 'false')

    await user.click(box)
    expect(kanbiniMock().mutate).toHaveBeenCalledWith({
      type: 'card.update',
      id: 'c-1',
      patch: { completed: true }
    })
    await waitFor(() => expect(kanbiniMock().agenda).toHaveBeenCalledTimes(2))
  })

  it('reopens a completed card', async () => {
    const user = userEvent.setup()
    renderPanel(
      agenda({ completed: [item({ cardId: 'c-2', title: 'Done it', completedAt: Date.now() })] })
    )
    const box = await screen.findByRole('checkbox', { name: /mark "done it" incomplete/i })
    expect(box).toHaveAttribute('aria-checked', 'true')
    await user.click(box)
    expect(kanbiniMock().mutate).toHaveBeenCalledWith({
      type: 'card.update',
      id: 'c-2',
      patch: { completed: false }
    })
  })
})

describe('<AgendaPanel> blocked cards', () => {
  it('marks a blocked card with a lock', async () => {
    renderPanel(agenda({ today: [item({ title: 'Stuck', blocked: true }), item({ title: 'Free' })] }))
    const list = await screen.findByRole('list', { name: /due today/i })
    const [stuck, free] = within(list).getAllByRole('listitem')
    expect(within(stuck!).getByRole('img', { name: /blocked/i })).toBeInTheDocument()
    expect(within(free!).queryByRole('img', { name: /blocked/i })).not.toBeInTheDocument()
  })
})
