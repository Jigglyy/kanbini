import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CardNumberBadge, CardNumberCopy } from '../card-number'

describe('<CardNumberBadge>', () => {
  it('shows the #number', () => {
    render(<CardNumberBadge number={142} />)
    expect(screen.getByText('#142')).toBeInTheDocument()
  })

  it('renders nothing for an unsaved card (number 0)', () => {
    const { container } = render(<CardNumberBadge number={0} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('<CardNumberCopy>', () => {
  it('copies "#N" and says so', async () => {
    const user = userEvent.setup()
    render(<CardNumberCopy number={7} />)
    await user.click(screen.getByRole('button', { name: 'Copy card number #7' }))
    expect(await navigator.clipboard.readText()).toBe('#7')
    expect(screen.getByRole('button', { name: 'Copied #7' })).toBeInTheDocument()
  })

  it('renders nothing for an unsaved card (number 0)', () => {
    const { container } = render(<CardNumberCopy number={0} />)
    expect(container).toBeEmptyDOMElement()
  })
})
