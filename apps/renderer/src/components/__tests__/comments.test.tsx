import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CardView, CommentView, Mutation } from '@kanbini/shared'

// Tests for the Comments surface. The composer uses TipTap (useEditor
// + useEditorState) and MarkdownView renders comment bodies through
// the same stack. ProseMirror state isn't friendly to JSDOM, so we
// stub the TipTap-bound primitives at the module boundary - same
// shape as the TODO (e) suggestion. The composer's data flow
// (typed value → submit → optimistic comment.create + clearContent)
// stays testable; we just replace the rich editor with a textarea
// that exposes the same interface.

vi.mock('@tiptap/react', async () => {
  // Editor stub holds the raw markdown string in plain memory so the
  // composer's getMarkdown() returns it on submit. Stable per
  // useEditor call site via useRef → useState pattern so that
  // re-renders don't blow away typed content.
  const React = await import('react')
  type Listener = () => void
  interface Stub {
    isEmpty: boolean
    isFocused: boolean
    storage: { markdown: { getMarkdown: () => string } }
    commands: { clearContent: () => void; blur: () => void }
    _setContent: (next: string) => void
    _setFocused: (next: boolean) => void
    _subscribe: (cb: Listener) => () => void
  }
  function makeEditor(): Stub {
    const state = { content: '', focused: false }
    const subs = new Set<Listener>()
    const notify = (): void => subs.forEach((s) => s())
    return {
      get isEmpty() {
        return state.content.trim().length === 0
      },
      get isFocused() {
        return state.focused
      },
      storage: {
        markdown: { getMarkdown: () => state.content }
      },
      commands: {
        clearContent: () => {
          state.content = ''
          notify()
        },
        blur: () => {
          state.focused = false
          notify()
        }
      },
      _setContent: (next: string) => {
        state.content = next
        notify()
      },
      _setFocused: (next: boolean) => {
        state.focused = next
        notify()
      },
      _subscribe: (cb: Listener) => {
        subs.add(cb)
        return () => subs.delete(cb)
      }
    }
  }
  return {
    useEditor: (_options: unknown) => {
      // Stable instance via useRef: the editor outlives re-renders
      // of the calling component (matches the real useEditor contract).
      const ref = React.useRef<Stub | null>(null)
      if (ref.current === null) ref.current = makeEditor()
      return ref.current
    },
    useEditorState: ({
      editor,
      selector
    }: {
      editor: Stub
      selector: (ctx: { editor: Stub | null }) => unknown
    }) => {
      // Subscribe so the calling component re-renders when the editor
      // state changes (typed content, focus, etc.). Mirrors the real
      // useEditorState behaviour.
      const [, setTick] = React.useState(0)
      React.useEffect(
        () => editor._subscribe(() => setTick((t) => t + 1)),
        [editor]
      )
      return selector({ editor })
    },
    EditorContent: ({ editor }: { editor: Stub }) => {
      // Render a textarea + wire change events to the stub editor
      // so `getMarkdown()` reflects what was typed.
      return (
        <textarea
          aria-label="comment composer"
          onChange={(e) => editor._setContent(e.target.value)}
          onFocus={() => editor._setFocused(true)}
          onBlur={() => editor._setFocused(false)}
        />
      )
    }
  }
})

// MarkdownView calls useEditor too - short-circuit to a plain div so
// existing comment bodies render readably without a real ProseMirror.
vi.mock('../ui/markdown-editor', async () => {
  const actual = await vi.importActual<typeof import('../ui/markdown-editor')>(
    '../ui/markdown-editor'
  )
  return {
    ...actual,
    MarkdownView: ({ value }: { value: string }) => (
      <div data-testid="markdown-view">{value}</div>
    ),
    // The composer renders RevealingToolbar (Toolbar + the ADR-0058
    // reveal-animation wrapper). Stub it directly - the real one calls
    // the module-internal Toolbar, which drives TipTap's isActive and
    // can't run in JSDOM. Same testid so the "toolbar appears" assertion
    // still anchors on it.
    RevealingToolbar: () => <div data-testid="toolbar" />,
    Toolbar: () => <div data-testid="toolbar" />,
    buildExtensions: () => []
  }
})

import { Comments } from '../comments'

function makeComment(overrides: Partial<CommentView> = {}): CommentView {
  return {
    id: 'cm1',
    body: 'Sample comment',
    author: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
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

describe('<Comments>', () => {
  it('renders the composer + section heading', () => {
    render(<Comments card={makeCard()} apply={vi.fn()} />)
    expect(
      screen.getByRole('heading', { name: 'Comments' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('textbox', { name: 'comment composer' })
    ).toBeInTheDocument()
  })

  it('shows the "no comments yet" hint when the thread is empty', () => {
    render(<Comments card={makeCard()} apply={vi.fn()} />)
    expect(screen.getByText(/no comments yet/i)).toBeInTheDocument()
  })

  it('renders one item per comment + the "You" badge for human authors', () => {
    const card = makeCard({
      comments: [
        makeComment({ id: 'cm1', body: 'first', author: null }),
        makeComment({ id: 'cm2', body: 'second', author: null })
      ]
    })
    render(<Comments card={card} apply={vi.fn()} />)
    const views = screen.getAllByTestId('markdown-view')
    expect(views.map((v) => v.textContent)).toEqual(['first', 'second'])
    // "You" appears twice (once per comment); "AI" should not appear.
    expect(screen.getAllByText('You').length).toBe(2)
    expect(screen.queryByText('AI')).toBeNull()
  })

  it('renders the "AI" badge for author === "ai"', () => {
    const card = makeCard({
      comments: [makeComment({ id: 'cm1', author: 'ai' })]
    })
    render(<Comments card={card} apply={vi.fn()} />)
    expect(screen.getByText('AI')).toBeInTheDocument()
    expect(screen.queryByText('You')).toBeNull()
  })

  it('Delete button fires comment.delete with the comment id', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    const card = makeCard({
      comments: [makeComment({ id: 'cm-x' })]
    })
    render(<Comments card={card} apply={apply} />)
    await user.click(
      screen.getByRole('button', { name: /delete comment/i })
    )
    expect(apply.mock.calls[0]![0]).toEqual({
      type: 'comment.delete',
      id: 'cm-x'
    })
  })

  it('Comment button is disabled until the composer has content', async () => {
    render(<Comments card={makeCard()} apply={vi.fn()} />)
    // The composer's toolbar+submit row only appears once focused or
    // non-empty (showToolbar = focused || !empty). On first paint
    // neither is true, so no Comment button is rendered yet.
    expect(
      screen.queryByRole('button', { name: 'Comment' })
    ).toBeNull()
  })

  it('typing in the composer reveals the toolbar + Comment button', async () => {
    const user = userEvent.setup()
    render(<Comments card={makeCard()} apply={vi.fn()} />)
    const textbox = screen.getByRole('textbox', { name: 'comment composer' })
    await user.type(textbox, 'Hello world')
    // Composer is now non-empty + focused → toolbar + button appear.
    expect(screen.getByTestId('toolbar')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Comment' })
    ).toBeInTheDocument()
  })

  it('clicking Comment fires comment.create with the trimmed body', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<(m: Mutation, o: unknown) => void>()
    render(<Comments card={makeCard()} apply={apply} />)
    const textbox = screen.getByRole('textbox', { name: 'comment composer' })
    await user.type(textbox, 'Hello world')
    await user.click(screen.getByRole('button', { name: 'Comment' }))
    expect(apply.mock.calls[0]![0]).toEqual({
      type: 'comment.create',
      cardId: 'c1',
      body: 'Hello world'
    })
  })
})
