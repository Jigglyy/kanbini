import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {
  AttachmentView,
  CardView,
  Mutation
} from '@kanbini/shared'
import { Attachments, CardCoverThumb, CoverImage } from '../attachments'
import { kanbiniMock } from '../../__tests__/_kanbini-mock'

// Tests for the attachments surface - three exported pieces:
//   - <Attachments>: list + add + delete + make/remove cover
//   - <CoverImage>: cover banner on the card-detail modal
//   - <CardCoverThumb>: in-list cover thumbnail with URL-domain chip

function makeAttachment(
  overrides: Partial<AttachmentView> = {}
): AttachmentView {
  return {
    id: 'a1',
    filename: 'doc.pdf',
    relPath: 'attachments/a1/doc.pdf',
    mime: 'application/pdf',
    size: 2048,
    sourceUrl: null,
    sourceTitle: null,
    createdAt: Date.now(),
    ...overrides
  }
}

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

describe('<Attachments>', () => {
  it('shows the "no attachments yet" hint when the list is empty', () => {
    render(<Attachments card={makeCard()} apply={vi.fn()} />)
    expect(screen.getByText(/no attachments yet/i)).toBeInTheDocument()
  })

  it('renders one row per attachment with size + filename', () => {
    const card = makeCard({
      attachments: [
        makeAttachment({ id: 'a1', filename: 'spec.md', size: 512 }),
        makeAttachment({ id: 'a2', filename: 'logo.png', size: 1024 ** 2 })
      ]
    })
    render(<Attachments card={card} apply={vi.fn()} />)
    expect(screen.getByText('spec.md')).toBeInTheDocument()
    expect(screen.getByText(/512 B/)).toBeInTheDocument()
    expect(screen.getByText('logo.png')).toBeInTheDocument()
    expect(screen.getByText(/1\.0 MB/)).toBeInTheDocument()
  })

  it('Add attachment fires ipc.attachmentAdd with the card id', async () => {
    const user = userEvent.setup()
    const mock = kanbiniMock()
    mock.attachmentAdd.mockResolvedValueOnce(makeAttachment())
    render(<Attachments card={makeCard()} apply={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /add attachment/i }))
    await waitFor(() => {
      expect(mock.attachmentAdd).toHaveBeenCalledWith('c1')
    })
  })

  it('Delete button fires attachment.delete with an optimistic remover', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    const card = makeCard({
      attachments: [makeAttachment({ id: 'a1', filename: 'doc.pdf' })]
    })
    render(<Attachments card={card} apply={apply} />)
    await user.click(
      screen.getByRole('button', { name: /delete attachment/i })
    )
    expect(apply).toHaveBeenCalledTimes(1)
    const [mutation, optimistic] = apply.mock.calls[0]!
    expect(mutation).toEqual({ type: 'attachment.delete', id: 'a1' })
    expect(typeof optimistic).toBe('function')
  })

  it("Make cover fires card.update with the attachment id (for image rows)", async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    const card = makeCard({
      attachments: [
        makeAttachment({ id: 'pic-1', filename: 'pic.png', mime: 'image/png' })
      ]
    })
    render(<Attachments card={card} apply={apply} />)
    await user.click(screen.getByRole('button', { name: 'Make cover' }))
    expect(apply.mock.calls[0]![0]).toEqual({
      type: 'card.update',
      id: 'c1',
      patch: { coverAttachmentId: 'pic-1' }
    })
  })

  it("Remove cover fires card.update with coverAttachmentId: null", async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    const card = makeCard({
      attachments: [
        makeAttachment({ id: 'pic-1', filename: 'pic.png', mime: 'image/png' })
      ],
      coverAttachmentId: 'pic-1'
    })
    render(<Attachments card={card} apply={apply} />)
    await user.click(screen.getByRole('button', { name: 'Remove cover' }))
    expect(apply.mock.calls[0]![0]).toEqual({
      type: 'card.update',
      id: 'c1',
      patch: { coverAttachmentId: null }
    })
  })

  it('cover badge ("Cover") shows on the row that is the current cover', () => {
    const card = makeCard({
      attachments: [
        makeAttachment({ id: 'pic-1', filename: 'pic.png', mime: 'image/png' }),
        makeAttachment({ id: 'pic-2', filename: 'other.png', mime: 'image/png' })
      ],
      coverAttachmentId: 'pic-1'
    })
    render(<Attachments card={card} apply={vi.fn()} />)
    expect(screen.getByText('Cover')).toBeInTheDocument()
  })

  it('non-image attachments do NOT show Make cover (cover requires image)', () => {
    const card = makeCard({
      attachments: [makeAttachment({ filename: 'doc.pdf', mime: 'application/pdf' })]
    })
    render(<Attachments card={card} apply={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Make cover' })).toBeNull()
  })

  it('extension fallback treats .heic as image even without a MIME', () => {
    const card = makeCard({
      attachments: [
        makeAttachment({ filename: 'beach.heic', mime: null })
      ]
    })
    render(<Attachments card={card} apply={vi.fn()} />)
    // Image-only path → Make cover should render.
    expect(
      screen.getByRole('button', { name: 'Make cover' })
    ).toBeInTheDocument()
  })

  it('clicking the image thumb opens the lightbox', async () => {
    const user = userEvent.setup()
    const card = makeCard({
      attachments: [
        makeAttachment({ id: 'pic-1', filename: 'pic.png', mime: 'image/png' })
      ]
    })
    render(<Attachments card={card} apply={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /preview image/i }))
    // The lightbox uses the filename as alt text on the full-size image.
    expect(screen.getByAltText('pic.png')).toBeInTheDocument()
  })
})

describe('<CoverImage>', () => {
  it('renders nothing when the card has no cover', () => {
    const { container } = render(<CoverImage card={makeCard()} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when the cover attachment is not an image', () => {
    const card = makeCard({
      attachments: [makeAttachment({ id: 'doc-1', filename: 'doc.pdf' })],
      coverAttachmentId: 'doc-1'
    })
    const { container } = render(<CoverImage card={card} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the cover image when the cover is an image', () => {
    const card = makeCard({
      attachments: [
        makeAttachment({
          id: 'pic-1',
          filename: 'banner.png',
          mime: 'image/png'
        })
      ],
      coverAttachmentId: 'pic-1'
    })
    render(<CoverImage card={card} />)
    expect(screen.getByAltText('banner.png')).toBeInTheDocument()
  })

  it('renders a source-URL footer with the title when sourceUrl is set', () => {
    const card = makeCard({
      attachments: [
        makeAttachment({
          id: 'pic-1',
          filename: 'preview.jpg',
          mime: 'image/jpeg',
          sourceUrl: 'https://example.com/article',
          sourceTitle: 'Article title'
        })
      ],
      coverAttachmentId: 'pic-1'
    })
    render(<CoverImage card={card} />)
    const link = screen.getByRole('link', { name: 'Article title' })
    expect(link).toHaveAttribute('href', 'https://example.com/article')
    // Plus the domain chip on the right.
    expect(screen.getByText('example.com')).toBeInTheDocument()
  })

  it('decodes HTML entities in the source title (&#x26BD; → ⚽)', () => {
    // Regression (ADR-0057): a Roblox page title arrives HTML-escaped;
    // the footer used to show the raw "[&#x26BD;] …" entity.
    const card = makeCard({
      attachments: [
        makeAttachment({
          id: 'pic-1',
          filename: 'preview.jpg',
          mime: 'image/jpeg',
          sourceUrl: 'https://www.roblox.com/games/1/Soccer-Incremental',
          sourceTitle: '[&#x26BD;] Soccer Incremental'
        })
      ],
      coverAttachmentId: 'pic-1'
    })
    render(<CoverImage card={card} />)
    expect(
      screen.getByRole('link', { name: '[⚽] Soccer Incremental' })
    ).toBeInTheDocument()
  })

  it('right-click → Copy link writes the source URL to the clipboard', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true
    })
    const card = makeCard({
      attachments: [
        makeAttachment({
          id: 'pic-1',
          filename: 'preview.jpg',
          mime: 'image/jpeg',
          sourceUrl: 'https://example.com/article',
          sourceTitle: 'Article title'
        })
      ],
      coverAttachmentId: 'pic-1'
    })
    render(<CoverImage card={card} />)
    // contextmenu bubbles from the link up to the footer's onContextMenu.
    fireEvent.contextMenu(screen.getByRole('link', { name: 'Article title' }))
    await user.click(await screen.findByText('Copy link'))
    expect(writeText).toHaveBeenCalledWith('https://example.com/article')
    // Menu closes after the action.
    await waitFor(() => expect(screen.queryByText('Copy link')).toBeNull())
  })

  it('clicking the image opens the lightbox', async () => {
    const user = userEvent.setup()
    const card = makeCard({
      attachments: [
        makeAttachment({
          id: 'pic-1',
          filename: 'banner.png',
          mime: 'image/png'
        })
      ],
      coverAttachmentId: 'pic-1'
    })
    render(<CoverImage card={card} />)
    await user.click(
      screen.getByRole('button', { name: /expand cover image/i })
    )
    // The lightbox uses the filename as alt text - both the inline
    // cover img and the lightbox img carry it.
    expect(screen.getAllByAltText('banner.png').length).toBeGreaterThan(1)
  })
})

describe('<CardCoverThumb>', () => {
  it('returns null when there is no cover', () => {
    const { container } = render(<CardCoverThumb card={makeCard()} />)
    expect(container.firstChild).toBeNull()
  })

  it('returns null when the cover attachment is not an image', () => {
    const card = makeCard({
      attachments: [makeAttachment({ id: 'doc-1', filename: 'doc.pdf' })],
      coverAttachmentId: 'doc-1'
    })
    const { container } = render(<CardCoverThumb card={card} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the thumb image when the cover is an image', () => {
    const card = makeCard({
      attachments: [
        makeAttachment({ id: 'pic', filename: 'thumb.png', mime: 'image/png' })
      ],
      coverAttachmentId: 'pic'
    })
    const { container } = render(<CardCoverThumb card={card} />)
    expect(container.querySelector('img')).toBeTruthy()
  })

  it('adds a domain chip when the cover came from a URL fetch', () => {
    const card = makeCard({
      attachments: [
        makeAttachment({
          id: 'pic',
          filename: 'thumb.png',
          mime: 'image/png',
          sourceUrl: 'https://news.example.com/story'
        })
      ],
      coverAttachmentId: 'pic'
    })
    render(<CardCoverThumb card={card} />)
    expect(screen.getByText('news.example.com')).toBeInTheDocument()
  })

  it('fires onClick when given (in-list mode)', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    const card = makeCard({
      attachments: [
        makeAttachment({ id: 'pic', filename: 'thumb.png', mime: 'image/png' })
      ],
      coverAttachmentId: 'pic'
    })
    const { container } = render(
      <CardCoverThumb card={card} onClick={onClick} />
    )
    await user.click(container.firstChild as Element)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
