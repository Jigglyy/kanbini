import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HiddenCardNotice } from '../hidden-card-notice'

describe('<HiddenCardNotice>', () => {
  it.each([
    [{ byLabels: true, byCompleted: false }, 'hidden by your label filter.'],
    [{ byLabels: false, byCompleted: true }, 'hidden by Hide completed.'],
    [
      { byLabels: true, byCompleted: true },
      'hidden by your label filter and Hide completed.'
    ]
  ])('says what hides the card (%o)', (by, text) => {
    render(
      <HiddenCardNotice
        reason={{ title: 'Fix login', ...by }}
        onShow={vi.fn()}
        onDismiss={vi.fn()}
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent(`“Fix login” is ${text}`)
  })

  it('Show it and Dismiss call back', async () => {
    const user = userEvent.setup()
    const onShow = vi.fn()
    const onDismiss = vi.fn()
    render(
      <HiddenCardNotice
        reason={{ title: 'Fix login', byLabels: true, byCompleted: false }}
        onShow={onShow}
        onDismiss={onDismiss}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Show it' }))
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onShow).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
