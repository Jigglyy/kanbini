import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CardRef, CardView, SearchHit } from '@kanbini/shared'
import { BlockedBadge, CardDependencies } from '../dependencies'
import { kanbiniMock } from '../../__tests__/_kanbini-mock'
import { renderWithQuery } from '../../__tests__/_render'

// "Waiting on" links in the renderer: the preview badge and the card
// detail section (list, open, remove, add via search, rejected adds).

function ref(over: Partial<CardRef> = {}): CardRef {
  return {
    cardId: 'r1',
    title: 'Other card',
    completed: false,
    archived: false,
    boardId: 'b1',
    boardName: 'Work',
    listName: 'To Do',
    ...over
  }
}

function makeCard(over: Partial<CardView> = {}): CardView {
  return {
    id: 'c1',
    title: 'This card',
    description: null,
    position: 'a',
    completed: false,
    dueAt: null,
    priority: null,
    collapsed: null,
    labelIds: [],
    checklists: [],
    comments: [],
    attachments: [],
    coverAttachmentId: null,
    activities: [],
    blockedBy: [],
    blocking: [],
    ...over
  }
}

function hit(over: Partial<SearchHit> = {}): SearchHit {
  return {
    cardId: 'h1',
    title: 'Found card',
    descriptionSnippet: null,
    boardId: 'b1',
    boardName: 'Work',
    listName: 'Doing',
    matchedLabels: [],
    matchKind: 'title',
    updatedAt: 0,
    ...over
  }
}

function renderSection(card: CardView, onOpenCard = vi.fn()) {
  renderWithQuery(
    <CardDependencies card={card} boardId="b1" onOpenCard={onOpenCard} />
  )
  return { onOpenCard }
}

describe('<BlockedBadge>', () => {
  it('shows while a blocker is open and names it', () => {
    render(<BlockedBadge card={makeCard({ blockedBy: [ref({ title: 'Design' })] })} />)
    const badge = screen.getByText('Blocked')
    expect(badge.closest('span')).toHaveAttribute('title', 'Waiting on "Design"')
  })

  it('hides once every blocker is done or archived', () => {
    const { container } = render(
      <BlockedBadge
        card={makeCard({
          blockedBy: [ref({ completed: true }), ref({ cardId: 'r2', archived: true })]
        })}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('hides on a completed card', () => {
    const { container } = render(
      <BlockedBadge card={makeCard({ completed: true, blockedBy: [ref()] })} />
    )
    expect(container).toBeEmptyDOMElement()
  })
})

describe('<CardDependencies>', () => {
  it('says so when the card waits on nothing', () => {
    renderSection(makeCard())
    expect(screen.getByText(/not waiting on anything/i)).toBeInTheDocument()
    expect(screen.queryByText(/waiting on this card/i)).not.toBeInTheDocument()
  })

  it('lists blockers with where they live, and opens one on click', async () => {
    const user = userEvent.setup()
    const { onOpenCard } = renderSection(
      makeCard({
        blockedBy: [
          ref({ cardId: 'same', title: 'Same board', listName: 'Doing' }),
          ref({
            cardId: 'far',
            title: 'Other board',
            boardId: 'b2',
            boardName: 'Home',
            listName: 'Errands'
          })
        ]
      })
    )
    const list = screen.getByRole('list', { name: /cards this is waiting on/i })
    expect(within(list).getByText('Doing')).toBeInTheDocument()
    expect(within(list).getByText('Home · Errands')).toBeInTheDocument()

    await user.click(within(list).getByRole('button', { name: 'Other board' }))
    expect(onOpenCard).toHaveBeenCalledWith('b2', 'far')
  })

  it('shows an archived blocker without a link to open', () => {
    renderSection(makeCard({ blockedBy: [ref({ title: 'Old', archived: true })] }))
    expect(screen.getByText(/\(archived\)/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Old' })).not.toBeInTheDocument()
  })

  it('removes a blocker', async () => {
    const user = userEvent.setup()
    renderSection(makeCard({ blockedBy: [ref({ cardId: 'r9', title: 'Design' })] }))
    await user.click(screen.getByRole('button', { name: 'Stop waiting on "Design"' }))
    expect(kanbiniMock().mutate).toHaveBeenCalledWith({
      type: 'card.removeBlocker',
      id: 'c1',
      blockerId: 'r9'
    })
  })

  it('lists and unlinks cards waiting on this one', async () => {
    const user = userEvent.setup()
    renderSection(makeCard({ blocking: [ref({ cardId: 'w1', title: 'Launch' })] }))
    expect(screen.getByRole('heading', { name: /waiting on this card/i })).toBeInTheDocument()
    await user.click(
      screen.getByRole('button', { name: 'Stop "Launch" waiting on this card' })
    )
    expect(kanbiniMock().mutate).toHaveBeenCalledWith({
      type: 'card.removeBlocker',
      id: 'w1',
      blockerId: 'c1'
    })
  })

  it('adds a blocker from search, leaving out itself and linked cards', async () => {
    const user = userEvent.setup()
    kanbiniMock().searchCards.mockResolvedValue([
      hit({ cardId: 'c1', title: 'This card' }),
      hit({ cardId: 'r1', title: 'Already linked' }),
      hit({ cardId: 'w1', title: 'Waits on this' }),
      hit({ cardId: 'h2', title: 'Pick me' })
    ])
    renderSection(
      makeCard({
        blockedBy: [ref({ cardId: 'r1', title: 'Already linked' })],
        blocking: [ref({ cardId: 'w1', title: 'Waits on this' })]
      })
    )

    await user.click(screen.getByRole('button', { name: /add a card/i }))
    const input = screen.getByRole('combobox', { name: /search for the card to wait on/i })
    expect(input).toHaveFocus()
    await user.type(input, 'pick')

    const options = await screen.findAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['Pick meWork · Doing'])
    await user.click(options[0]!)

    expect(kanbiniMock().mutate).toHaveBeenCalledWith({
      type: 'card.addBlocker',
      id: 'c1',
      blockerId: 'h2'
    })
    await waitFor(() =>
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    )
  })

  it('picks with the keyboard and cancels with Escape', async () => {
    const user = userEvent.setup()
    kanbiniMock().searchCards.mockResolvedValue([
      hit({ cardId: 'h1', title: 'First' }),
      hit({ cardId: 'h2', title: 'Second' })
    ])
    renderSection(makeCard())
    await user.click(screen.getByRole('button', { name: /add a card/i }))
    await user.type(screen.getByRole('combobox'), 'x')
    await screen.findAllByRole('option')
    await user.keyboard('{ArrowDown}{Enter}')
    expect(kanbiniMock().mutate).toHaveBeenLastCalledWith({
      type: 'card.addBlocker',
      id: 'c1',
      blockerId: 'h2'
    })

    await user.click(await screen.findByRole('button', { name: /add a card/i }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('explains a rejected add and keeps the search open', async () => {
    const user = userEvent.setup()
    kanbiniMock().searchCards.mockResolvedValue([hit({ cardId: 'h1', title: 'Loop' })])
    kanbiniMock().mutate.mockRejectedValueOnce(
      new Error('card h1 already waits on card c1 ... this link would make a loop')
    )
    renderSection(makeCard())
    await user.click(screen.getByRole('button', { name: /add a card/i }))
    await user.type(screen.getByRole('combobox'), 'loop')
    await user.click((await screen.findAllByRole('option'))[0]!)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /already waiting on this one/i
    )
    expect(screen.getByRole('combobox')).toBeInTheDocument()
  })
})

describe('<CardDependencies> Escape', () => {
  it('stops at the search so the surrounding card detail stays open', async () => {
    const user = userEvent.setup()
    const outer = vi.fn()
    document.addEventListener('keydown', outer)
    try {
      renderSection(makeCard())
      await user.click(screen.getByRole('button', { name: /add a card/i }))
      await user.keyboard('{Escape}')
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
      expect(outer).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', outer)
    }
  })
})
