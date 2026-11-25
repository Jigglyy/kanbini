import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MultiDragBlock } from '../drag-block'

// The drag overlay's content for a multi-selection drag: the grabbed
// card, a count badge, and the other selected cards listed under it
// (capped, with a "+N more" line). A single-card drag must render the
// grabbed card alone, exactly as before.

const followers = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `c${i}`, face: <div>Card {i}</div> }))

describe('<MultiDragBlock>', () => {
  it('lists the other selected cards under the grabbed one, with a count', () => {
    const { container } = render(
      <MultiDragBlock followers={followers(2)}>
        <div>Grabbed</div>
      </MultiDragBlock>
    )
    expect(screen.getByText('Grabbed')).toBeInTheDocument()
    expect(screen.getByText('Card 0')).toBeInTheDocument()
    expect(screen.getByText('Card 1')).toBeInTheDocument()
    expect(container.querySelector('[data-drag-count]')).toHaveTextContent('3')
    expect(screen.queryByText(/more$/)).toBeNull()
  })

  it('caps the block at four faces and counts the rest', () => {
    const { container } = render(
      <MultiDragBlock followers={followers(5)}>
        <div>Grabbed</div>
      </MultiDragBlock>
    )
    expect(container.querySelectorAll('[data-drag-follower]')).toHaveLength(3)
    expect(screen.queryByText('Card 3')).toBeNull()
    expect(screen.getByText('+2 more')).toBeInTheDocument()
    expect(container.querySelector('[data-drag-count]')).toHaveTextContent('6')
  })

  it('renders only the card for a single-card drag', () => {
    const { container } = render(
      <MultiDragBlock followers={[]}>
        <div>Grabbed</div>
      </MultiDragBlock>
    )
    expect(container.innerHTML).toBe('<div>Grabbed</div>')
  })
})
