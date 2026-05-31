import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CardView } from '@kanbini/shared'
import { UrlCoverModal } from '../url-cover-modal'
import { kanbiniMock } from '../../__tests__/_kanbini-mock'

// Tests for the ADR-0023 URL-cover modal - the only renderer surface
// that touches the network. Two intertwined flows:
//   1. Consent: link previews are OFF by default; the modal shows a
//      panel that must be accepted (inline, no leaving the dialog)
//      before submit is enabled.
//   2. Submit: fires linkPreviewCreate; on `{ok:false}` shows the
//      error inline; on `{ok:true}` closes the modal (cover is
//      applied server-side via the broadcastChange path, no further
//      work in the renderer).

function makeCard(overrides: Partial<CardView> = {}): CardView {
  return {
    id: 'c1',
    title: 'Card',
    description: null,
    position: 'a',
    completed: false,
    dueAt: null,
    priority: null,
    labelIds: [],
    checklists: [],
    comments: [],
    attachments: [],
    coverAttachmentId: null,
    activities: [],
    ...overrides
  }
}

/** Pre-populate localStorage's settings blob with linkPreviews=true.
 *  useSettings reads from `kanbini.settings` on first render. */
function enableLinkPreviews(): void {
  window.localStorage.setItem(
    'kanbini.settings',
    JSON.stringify({ linkPreviews: true })
  )
}

describe('<UrlCoverModal>', () => {
  it('renders the consent panel when link previews are OFF', () => {
    render(
      <UrlCoverModal card={makeCard()} open onClose={() => {}} />
    )
    expect(screen.getByText(/link previews are off/i)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /enable link previews/i })
    ).toBeInTheDocument()
    // Input is rendered but disabled until consent.
    expect(screen.getByRole('textbox')).toBeDisabled()
  })

  it('Enable link previews flips the setting + hides the consent panel', async () => {
    const user = userEvent.setup()
    render(<UrlCoverModal card={makeCard()} open onClose={() => {}} />)
    await user.click(
      screen.getByRole('button', { name: /enable link previews/i })
    )
    // Consent text disappears; input becomes enabled.
    await waitFor(() => {
      expect(screen.queryByText(/link previews are off/i)).toBeNull()
    })
    expect(screen.getByRole('textbox')).not.toBeDisabled()
  })

  it('skips the consent panel when link previews are already ON', () => {
    enableLinkPreviews()
    render(<UrlCoverModal card={makeCard()} open onClose={() => {}} />)
    expect(screen.queryByText(/link previews are off/i)).toBeNull()
    expect(screen.getByRole('textbox')).not.toBeDisabled()
  })

  it('submit fires linkPreviewCreate with the trimmed URL + closes on success', async () => {
    enableLinkPreviews()
    const user = userEvent.setup()
    const onClose = vi.fn()
    const mock = kanbiniMock()
    mock.linkPreviewCreate.mockResolvedValueOnce({
      ok: true,
      attachmentId: 'att-1',
      boardId: 'b-1',
      sourceUrl: 'https://example.com',
      sourceTitle: 'Example'
    })
    render(<UrlCoverModal card={makeCard()} open onClose={onClose} />)
    await user.type(
      screen.getByRole('textbox'),
      '  https://example.com  '
    )
    await user.click(screen.getByRole('button', { name: /fetch preview/i }))
    await waitFor(() => {
      expect(mock.linkPreviewCreate).toHaveBeenCalledWith({
        cardId: 'c1',
        url: 'https://example.com'
      })
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("renders the error message inline when the IPC returns {ok:false}", async () => {
    enableLinkPreviews()
    const user = userEvent.setup()
    const onClose = vi.fn()
    const mock = kanbiniMock()
    mock.linkPreviewCreate.mockResolvedValueOnce({
      ok: false,
      error: 'No preview image found.'
    })
    render(<UrlCoverModal card={makeCard()} open onClose={onClose} />)
    await user.type(screen.getByRole('textbox'), 'https://example.com')
    await user.click(screen.getByRole('button', { name: /fetch preview/i }))
    expect(
      await screen.findByText('No preview image found.')
    ).toBeInTheDocument()
    // Modal stays open; user can retry.
    expect(onClose).not.toHaveBeenCalled()
  })

  it("catches thrown IPC errors and shows them as the error message", async () => {
    enableLinkPreviews()
    const user = userEvent.setup()
    const mock = kanbiniMock()
    mock.linkPreviewCreate.mockRejectedValueOnce(
      new Error('preload missing')
    )
    render(<UrlCoverModal card={makeCard()} open onClose={() => {}} />)
    await user.type(screen.getByRole('textbox'), 'https://example.com')
    await user.click(screen.getByRole('button', { name: /fetch preview/i }))
    expect(await screen.findByText('preload missing')).toBeInTheDocument()
  })

  it('Fetch preview button is disabled while linkPreviews is off', () => {
    render(<UrlCoverModal card={makeCard()} open onClose={() => {}} />)
    expect(
      screen.getByRole('button', { name: /fetch preview/i })
    ).toBeDisabled()
  })

  it('Fetch preview button is disabled when URL is empty', () => {
    enableLinkPreviews()
    render(<UrlCoverModal card={makeCard()} open onClose={() => {}} />)
    expect(
      screen.getByRole('button', { name: /fetch preview/i })
    ).toBeDisabled()
  })

  it('Cancel button calls onClose without firing the IPC', async () => {
    enableLinkPreviews()
    const user = userEvent.setup()
    const onClose = vi.fn()
    const mock = kanbiniMock()
    render(<UrlCoverModal card={makeCard()} open onClose={onClose} />)
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(mock.linkPreviewCreate).not.toHaveBeenCalled()
  })

  it('resets URL + error when reopened (open transitions false→true)', async () => {
    enableLinkPreviews()
    const user = userEvent.setup()
    const mock = kanbiniMock()
    mock.linkPreviewCreate.mockResolvedValueOnce({
      ok: false,
      error: 'first failure'
    })
    const { rerender } = render(
      <UrlCoverModal card={makeCard()} open onClose={() => {}} />
    )
    await user.type(screen.getByRole('textbox'), 'https://a.example')
    await user.click(screen.getByRole('button', { name: /fetch preview/i }))
    expect(await screen.findByText('first failure')).toBeInTheDocument()
    // Close + reopen - the effect on `open` should reset url + error.
    rerender(
      <UrlCoverModal card={makeCard()} open={false} onClose={() => {}} />
    )
    rerender(
      <UrlCoverModal card={makeCard()} open onClose={() => {}} />
    )
    expect(screen.queryByText('first failure')).toBeNull()
    expect(screen.getByRole('textbox')).toHaveValue('')
  })
})
