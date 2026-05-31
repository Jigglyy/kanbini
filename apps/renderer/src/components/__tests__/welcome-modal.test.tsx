import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WelcomeModal } from '../welcome-modal'

// M5-B first-run welcome (ADR-0049). Visual contract:
//   - open=false → nothing rendered (Modal short-circuits before
//     creating its portal, so the test asserts dialog absence)
//   - open=true → dialog visible with the "Welcome to Kanbini"
//     heading + Get started button
//   - clicking Get started fires onDismiss exactly once
//   - Escape on the document also fires onDismiss (Modal primitive)
//
// The "show once on install" lifecycle (settings.hasSeenWelcome) is
// driven by App.tsx, not the modal itself - the modal is pure /
// presentational here.

describe('<WelcomeModal>', () => {
  it('renders nothing when closed', () => {
    const onDismiss = vi.fn()
    render(<WelcomeModal open={false} onDismiss={onDismiss} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('renders the welcome content + Get started button when open', () => {
    render(<WelcomeModal open onDismiss={() => {}} />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: /welcome to kanbini/i })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /got it/i })
    ).toBeInTheDocument()
  })

  it('fires onDismiss when Get started is clicked', async () => {
    const onDismiss = vi.fn()
    const user = userEvent.setup()
    render(<WelcomeModal open onDismiss={onDismiss} />)
    await user.click(screen.getByRole('button', { name: /got it/i }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('fires onDismiss on Escape (Modal primitive contract)', async () => {
    const onDismiss = vi.fn()
    const user = userEvent.setup()
    render(<WelcomeModal open onDismiss={onDismiss} />)
    await user.keyboard('{Escape}')
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
