import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Tests for the WYSIWYG-stores-Markdown editor (ADR-0016). The
// rich editor itself is TipTap/ProseMirror, which doesn't render
// in JSDOM - we stub @tiptap/react at the module boundary with a
// useRef-backed stable editor instance that exposes the chain-
// command surface the Toolbar drives + a captured onUpdate
// callback the MarkdownEditor autosave path fires through.
//
// Same mocking pattern that landed in comments.test.tsx + card-
// detail.test.tsx (slice 4 of TODO e). Tests:
//   - buildExtensions: pure function (no mock needed)
//   - MarkdownView: renders without throwing, returns null when
//     the stub editor is null
//   - MarkdownField: read-only display ↔ edit toggle, placeholder
//     vs content, Escape and outside-click bail-out
//   - MarkdownEditor: autosave (debounced) + unmount-flush
//   - Toolbar: every button dispatches the matching command chain

interface ChainStub {
  focus: () => ChainStub
  toggleBold: () => ChainStub
  toggleItalic: () => ChainStub
  toggleStrike: () => ChainStub
  toggleCode: () => ChainStub
  toggleHeading: (opts: { level: number }) => ChainStub
  toggleBulletList: () => ChainStub
  toggleOrderedList: () => ChainStub
  toggleTaskList: () => ChainStub
  toggleBlockquote: () => ChainStub
  toggleCodeBlock: () => ChainStub
  setHorizontalRule: () => ChainStub
  extendMarkRange: (mark: string) => ChainStub
  setLink: (attrs: { href: string }) => ChainStub
  unsetLink: () => ChainStub
  undo: () => ChainStub
  redo: () => ChainStub
  run: () => boolean
}

interface EditorStub {
  storage: Record<string, unknown>
  isEmpty: boolean
  isFocused: boolean
  isActive: (...args: unknown[]) => boolean
  getAttributes: (mark: string) => Record<string, unknown>
  chain: () => ChainStub
  commands: {
    focus: (...args: unknown[]) => boolean
    clearContent: () => void
    blur: () => void
    setContent: (value: string) => void
  }
  /** Test-only: what onUpdate was called with, and a way to fire
   *  it as if a keystroke happened. Lets the autosave-debounce
   *  test drive the editor without actually editing anything. */
  _fireUpdate: (md: string) => void
  /** Test-only: every chain method call gets pushed here so the
   *  Toolbar test can assert which command sequence was dispatched
   *  for a given button. */
  _chainCalls: string[]
  /** Test-only: every `commands.focus(...)` call's args - lets the
   *  scroll-preservation test assert focus happened with
   *  `{ scrollIntoView: false }` (ADR-0058 description scroll-drift). */
  _focusCalls: unknown[][]
}

let lastEditor: EditorStub | null = null

vi.mock('@tiptap/react', async () => {
  const React = await import('react')

  function makeChain(calls: string[]): ChainStub {
    const chain: ChainStub = {
      focus: () => {
        calls.push('focus')
        return chain
      },
      toggleBold: () => {
        calls.push('toggleBold')
        return chain
      },
      toggleItalic: () => {
        calls.push('toggleItalic')
        return chain
      },
      toggleStrike: () => {
        calls.push('toggleStrike')
        return chain
      },
      toggleCode: () => {
        calls.push('toggleCode')
        return chain
      },
      toggleHeading: ({ level }) => {
        calls.push(`toggleHeading:${level}`)
        return chain
      },
      toggleBulletList: () => {
        calls.push('toggleBulletList')
        return chain
      },
      toggleOrderedList: () => {
        calls.push('toggleOrderedList')
        return chain
      },
      toggleTaskList: () => {
        calls.push('toggleTaskList')
        return chain
      },
      toggleBlockquote: () => {
        calls.push('toggleBlockquote')
        return chain
      },
      toggleCodeBlock: () => {
        calls.push('toggleCodeBlock')
        return chain
      },
      setHorizontalRule: () => {
        calls.push('setHorizontalRule')
        return chain
      },
      extendMarkRange: (mark) => {
        calls.push(`extendMarkRange:${mark}`)
        return chain
      },
      setLink: ({ href }) => {
        calls.push(`setLink:${href}`)
        return chain
      },
      unsetLink: () => {
        calls.push('unsetLink')
        return chain
      },
      undo: () => {
        calls.push('undo')
        return chain
      },
      redo: () => {
        calls.push('redo')
        return chain
      },
      run: () => true
    }
    return chain
  }

  function makeEditor(onUpdate?: (ctx: { editor: EditorStub }) => void): EditorStub {
    const state = { content: '', focused: false }
    const subs = new Set<() => void>()
    const notify = (): void => subs.forEach((cb) => cb())
    const calls: string[] = []
    const focusCalls: unknown[][] = []
    const editor: EditorStub = {
      storage: { markdown: { getMarkdown: () => state.content } },
      get isEmpty() {
        return state.content.trim().length === 0
      },
      get isFocused() {
        return state.focused
      },
      isActive: () => false,
      getAttributes: () => ({}),
      chain: () => makeChain(calls),
      commands: {
        focus: (...args: unknown[]) => {
          focusCalls.push(args)
          return true
        },
        clearContent: () => {
          state.content = ''
          notify()
        },
        blur: () => {
          state.focused = false
          notify()
        },
        // MarkdownView's useEffect calls this when its `value` prop
        // changes - fixes the initial-empty bug where an async-loaded
        // value left the editor frozen to the mount-time (empty)
        // value. `isEmpty` is a getter on the editor (computed from
        // state.content), so no need to set it separately.
        setContent: (next: string) => {
          state.content = next
          notify()
        }
      },
      _fireUpdate: (md) => {
        state.content = md
        notify()
        onUpdate?.({ editor })
      },
      _chainCalls: calls,
      _focusCalls: focusCalls
    }
    // Expose subscription via a non-enumerable hack so useEditorState
    // can subscribe without leaking the API to consumers.
    ;(editor as unknown as { _subscribe: (cb: () => void) => () => void })._subscribe = (
      cb
    ) => {
      subs.add(cb)
      return () => subs.delete(cb)
    }
    return editor
  }

  return {
    useEditor: (options: {
      onUpdate?: (ctx: { editor: EditorStub }) => void
    }) => {
      // Stable instance per useEditor call via useRef - keeps state
      // alive across re-renders the way the real hook does.
      const ref = React.useRef<EditorStub | null>(null)
      if (ref.current === null) {
        ref.current = makeEditor(options?.onUpdate)
        lastEditor = ref.current
      }
      return ref.current
    },
    useEditorState: ({
      editor,
      selector
    }: {
      editor: EditorStub | null
      selector: (ctx: { editor: EditorStub | null }) => unknown
    }) => {
      const [, setTick] = React.useState(0)
      React.useEffect(() => {
        if (!editor) return
        const sub = (editor as unknown as {
          _subscribe: (cb: () => void) => () => void
        })._subscribe
        return sub(() => setTick((t) => t + 1))
      }, [editor])
      return selector({ editor })
    },
    EditorContent: ({ editor }: { editor: EditorStub }) => (
      <div
        data-testid="editor-content"
        contentEditable
        suppressContentEditableWarning
        onFocus={() =>
          ((editor as unknown as { _setFocused?: (v: boolean) => void })
            ._setFocused ?? (() => {}))(true)
        }
      />
    )
  }
})

import {
  MarkdownEditor,
  MarkdownField,
  MarkdownView,
  buildExtensions
} from '../markdown-editor'

beforeEach(() => {
  lastEditor = null
})

// ─── buildExtensions ──────────────────────────────────────────────

describe('buildExtensions', () => {
  it('returns a non-empty array', () => {
    expect(Array.isArray(buildExtensions())).toBe(true)
    expect(buildExtensions().length).toBeGreaterThan(0)
  })

  it('placeholder is opt-in - different calls return distinct extension lists', () => {
    const a = buildExtensions('Hello')
    const b = buildExtensions()
    expect(a.length).toBe(b.length)
  })
})

// ─── MarkdownView ─────────────────────────────────────────────────

describe('MarkdownView', () => {
  it('renders the editor content surface for a non-empty value', () => {
    render(<MarkdownView value="some markdown" />)
    expect(screen.getByTestId('editor-content')).toBeInTheDocument()
  })

  it('renders the editor content surface for an empty value', () => {
    render(<MarkdownView value="" />)
    expect(screen.getByTestId('editor-content')).toBeInTheDocument()
  })

  it('updates the editor when the value prop changes (regression: async-loaded initial-empty bug)', () => {
    // useEditor captures `content` at mount; without an explicit
    // setContent in a useEffect, prop changes don't reach the
    // editor. An async-loaded value hit this - body starts as ''
    // then flips to real text after the load resolves - and the
    // editor rendered nothing.
    const { rerender } = render(<MarkdownView value="initial" />)
    // Mount-time effect fires setContent('initial')
    const getContent = () =>
      (lastEditor?.storage['markdown'] as { getMarkdown: () => string })
        .getMarkdown()
    expect(getContent()).toBe('initial')

    rerender(<MarkdownView value="updated" />)
    // Value-change effect fires setContent('updated')
    expect(getContent()).toBe('updated')
  })
})

// ─── MarkdownField ────────────────────────────────────────────────

describe('<MarkdownField>', () => {
  it('renders the placeholder when value is empty', () => {
    render(<MarkdownField value="" onChange={vi.fn()} placeholder="Type here…" />)
    expect(screen.getByText('Type here…')).toBeInTheDocument()
  })

  it('renders MarkdownView when value is non-empty', () => {
    render(
      <MarkdownField value="content" onChange={vi.fn()} />
    )
    expect(screen.getByTestId('editor-content')).toBeInTheDocument()
  })

  it('clicking the field switches to edit mode', async () => {
    const user = userEvent.setup()
    render(<MarkdownField value="" onChange={vi.fn()} />)
    const trigger = screen.getByRole('button')
    await user.click(trigger)
    // Toolbar appears in edit mode - assert via the Bold button.
    expect(
      screen.getByRole('button', { name: /Bold/ })
    ).toBeInTheDocument()
  })

  it('wraps the toolbar in the reveal-animation container (ADR-0057)', async () => {
    const user = userEvent.setup()
    const { container } = render(<MarkdownField value="" onChange={vi.fn()} />)
    await user.click(screen.getByRole('button'))
    // The animated grid wrapper drives the smooth open (index.css).
    const reveal = container.querySelector('.toolbar-reveal')
    expect(reveal).toBeTruthy()
    // The Bold button lives inside it - i.e. the wrapper actually holds
    // the toolbar, not some empty sibling.
    expect(reveal?.querySelector('button')).toBeTruthy()
  })

  it('Enter on the read-only trigger switches to edit mode', async () => {
    render(<MarkdownField value="" onChange={vi.fn()} />)
    const trigger = screen.getByRole('button')
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(
      screen.getByRole('button', { name: /Bold/ })
    ).toBeInTheDocument()
  })

  it('Space on the read-only trigger switches to edit mode', async () => {
    render(<MarkdownField value="" onChange={vi.fn()} />)
    const trigger = screen.getByRole('button')
    trigger.focus()
    fireEvent.keyDown(trigger, { key: ' ' })
    expect(
      screen.getByRole('button', { name: /Bold/ })
    ).toBeInTheDocument()
  })

  it('Escape exits edit mode', async () => {
    const user = userEvent.setup()
    render(<MarkdownField value="" onChange={vi.fn()} />)
    await user.click(screen.getByRole('button'))
    // In edit mode, Bold is in the document.
    expect(
      screen.getByRole('button', { name: /Bold/ })
    ).toBeInTheDocument()
    // Document-level Escape listener fires.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: /Bold/ })).toBeNull()
  })

  it('clicking the portaled Link popover does NOT exit edit mode', async () => {
    // Regression: the Link control opens a Popover at <body> (outside
    // rootRef). MarkdownField's outside-click handler must ignore clicks
    // inside that [data-overlay], or it tears the editor down mid-edit.
    const user = userEvent.setup()
    render(<MarkdownField value="" onChange={vi.fn()} />)
    await user.click(screen.getByRole('button')) // enter edit mode
    await user.click(screen.getByRole('button', { name: /^Link$/ }))
    const input = await screen.findByLabelText('Link URL')
    await user.click(input) // pointerdown inside the portaled popover
    expect(screen.getByRole('button', { name: /Bold/ })).toBeInTheDocument()
    expect(screen.getByLabelText('Link URL')).toBeInTheDocument()
  })

  it('Escape closes the Link popover first, keeping the field in edit mode', async () => {
    const user = userEvent.setup()
    render(<MarkdownField value="" onChange={vi.fn()} />)
    await user.click(screen.getByRole('button'))
    await user.click(screen.getByRole('button', { name: /^Link$/ }))
    await screen.findByLabelText('Link URL')
    await user.keyboard('{Escape}') // closes the popover, not the editor
    expect(screen.queryByLabelText('Link URL')).toBeNull()
    expect(screen.getByRole('button', { name: /Bold/ })).toBeInTheDocument()
  })

  it('outside-click exits edit mode', async () => {
    const user = userEvent.setup()
    render(
      <div>
        <button data-testid="outside">outside</button>
        <MarkdownField value="" onChange={vi.fn()} />
      </div>
    )
    await user.click(
      screen.getByRole('button', { name: 'outside' })
    )
    // Still display mode after clicking outside the field.
    expect(screen.queryByRole('button', { name: /Bold/ })).toBeNull()
    // Now enter edit mode + outside-click again.
    await user.click(screen.getAllByRole('button').find((b) => !b.textContent?.includes('outside'))!)
    expect(
      screen.getByRole('button', { name: /Bold/ })
    ).toBeInTheDocument()
    // Pointer-down outside the field exits edit mode.
    fireEvent.pointerDown(screen.getByTestId('outside'))
    expect(screen.queryByRole('button', { name: /Bold/ })).toBeNull()
  })
})

// ─── MarkdownEditor (autosave) ────────────────────────────────────

describe('<MarkdownEditor>', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('debounces onChange - single update fires after 500 ms, not before', () => {
    const onChange = vi.fn()
    render(<MarkdownEditor value="" onChange={onChange} />)
    expect(lastEditor).toBeTruthy()
    act(() => lastEditor!._fireUpdate('typed body'))
    // Before the 500 ms timeout, no onChange call yet.
    expect(onChange).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(499))
    expect(onChange).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('typed body')
  })

  it('coalesces rapid edits into a single trailing onChange', () => {
    const onChange = vi.fn()
    render(<MarkdownEditor value="" onChange={onChange} />)
    act(() => lastEditor!._fireUpdate('a'))
    act(() => vi.advanceTimersByTime(200))
    act(() => lastEditor!._fireUpdate('ab'))
    act(() => vi.advanceTimersByTime(200))
    act(() => lastEditor!._fireUpdate('abc'))
    // 200 + 200 = 400 ms so far; the third edit resets the debounce.
    act(() => vi.advanceTimersByTime(499))
    expect(onChange).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('abc')
  })

  it('flushes the pending edit on unmount (no in-flight loss)', () => {
    const onChange = vi.fn()
    const { unmount } = render(
      <MarkdownEditor value="" onChange={onChange} />
    )
    act(() => lastEditor!._fireUpdate('half-typed'))
    // No debounce time has passed; unmount should flush.
    unmount()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('half-typed')
  })

  it('does NOT fire on unmount when there is no pending edit', () => {
    const onChange = vi.fn()
    const { unmount } = render(
      <MarkdownEditor value="" onChange={onChange} />
    )
    unmount()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('autoFocus focuses end WITHOUT scrolling (ADR-0058 scroll-drift)', () => {
    // Regression: the description editor used TipTap's `autofocus: end`,
    // which scrolls the contenteditable into view on every mount and
    // crept the card-detail modal's scroll position upward over repeated
    // open/close. We now focus manually with scrollIntoView: false.
    render(<MarkdownEditor value="" onChange={vi.fn()} autoFocus />)
    expect(lastEditor).toBeTruthy()
    expect(lastEditor!._focusCalls).toContainEqual([
      'end',
      { scrollIntoView: false }
    ])
  })

  it('does not auto-focus when autoFocus is false (e.g. read context)', () => {
    render(<MarkdownEditor value="" onChange={vi.fn()} />)
    expect(lastEditor!._focusCalls).toEqual([])
  })
})

// ─── Toolbar ──────────────────────────────────────────────────────

describe('<Toolbar>', () => {
  /** Set up a Toolbar with a real (stub) editor instance via a host
   *  component so useEditor still provides our editor. */
  function renderToolbar() {
    function Host() {
      // useEditor reads from our mocked module; the stub captures
      // the editor into `lastEditor`.
      return (
        <>
          <MarkdownEditor value="" onChange={() => {}} />
        </>
      )
    }
    render(<Host />)
    expect(lastEditor).toBeTruthy()
    return lastEditor!
  }

  it("Bold button dispatches the toggleBold chain", async () => {
    const user = userEvent.setup()
    const editor = renderToolbar()
    editor._chainCalls.length = 0
    await user.click(screen.getByRole('button', { name: /Bold/ }))
    expect(editor._chainCalls).toContain('toggleBold')
  })

  it("Italic button dispatches the toggleItalic chain", async () => {
    const user = userEvent.setup()
    const editor = renderToolbar()
    editor._chainCalls.length = 0
    await user.click(screen.getByRole('button', { name: /Italic/ }))
    expect(editor._chainCalls).toContain('toggleItalic')
  })

  it('Heading buttons pass the right level', async () => {
    const user = userEvent.setup()
    const editor = renderToolbar()
    editor._chainCalls.length = 0
    await user.click(screen.getByRole('button', { name: /Heading 1/ }))
    expect(editor._chainCalls).toContain('toggleHeading:1')
    editor._chainCalls.length = 0
    await user.click(screen.getByRole('button', { name: /Heading 3/ }))
    expect(editor._chainCalls).toContain('toggleHeading:3')
  })

  it('list buttons dispatch toggleBulletList / toggleOrderedList / toggleTaskList', async () => {
    const user = userEvent.setup()
    const editor = renderToolbar()
    editor._chainCalls.length = 0
    await user.click(screen.getByRole('button', { name: /Bullet list/ }))
    expect(editor._chainCalls).toContain('toggleBulletList')
    editor._chainCalls.length = 0
    await user.click(screen.getByRole('button', { name: /Numbered list/ }))
    expect(editor._chainCalls).toContain('toggleOrderedList')
    editor._chainCalls.length = 0
    await user.click(screen.getByRole('button', { name: /Task list/ }))
    expect(editor._chainCalls).toContain('toggleTaskList')
  })

  it('block-level buttons dispatch blockquote / codeBlock / horizontal rule', async () => {
    const user = userEvent.setup()
    const editor = renderToolbar()
    editor._chainCalls.length = 0
    await user.click(screen.getByRole('button', { name: /Blockquote/ }))
    expect(editor._chainCalls).toContain('toggleBlockquote')
    editor._chainCalls.length = 0
    await user.click(screen.getByRole('button', { name: /Code block/ }))
    expect(editor._chainCalls).toContain('toggleCodeBlock')
    editor._chainCalls.length = 0
    await user.click(screen.getByRole('button', { name: /Horizontal rule/ }))
    expect(editor._chainCalls).toContain('setHorizontalRule')
  })

  it('Undo / Redo dispatch the corresponding history commands', async () => {
    const user = userEvent.setup()
    const editor = renderToolbar()
    editor._chainCalls.length = 0
    await user.click(screen.getByRole('button', { name: /Undo/ }))
    expect(editor._chainCalls).toContain('undo')
    editor._chainCalls.length = 0
    await user.click(screen.getByRole('button', { name: /Redo/ }))
    expect(editor._chainCalls).toContain('redo')
  })

  // The Link control is a Popover with a URL input - NOT window.prompt
  // (Electron disables prompt() in the renderer, so the old button was a
  // dead no-op in the packaged app). These drive the input flow.
  it('Link button opens a URL input + dispatches setLink on Enter', async () => {
    const user = userEvent.setup()
    const editor = renderToolbar()
    editor._chainCalls.length = 0
    await user.click(screen.getByRole('button', { name: /^Link$/ }))
    const input = await screen.findByLabelText('Link URL')
    await user.type(input, 'https://example.com')
    await user.keyboard('{Enter}')
    expect(editor._chainCalls).toContain('setLink:https://example.com')
  })

  it('Link button also applies via the Apply button', async () => {
    const user = userEvent.setup()
    const editor = renderToolbar()
    editor._chainCalls.length = 0
    await user.click(screen.getByRole('button', { name: /^Link$/ }))
    await user.type(await screen.findByLabelText('Link URL'), 'https://x.dev')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(editor._chainCalls).toContain('setLink:https://x.dev')
  })

  it('Link popover with an empty input unsets the link', async () => {
    const user = userEvent.setup()
    const editor = renderToolbar()
    editor._chainCalls.length = 0
    await user.click(screen.getByRole('button', { name: /^Link$/ }))
    await screen.findByLabelText('Link URL')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(editor._chainCalls).toContain('unsetLink')
  })

  it('Escape closes the Link popover without dispatching', async () => {
    const user = userEvent.setup()
    const editor = renderToolbar()
    editor._chainCalls.length = 0
    await user.click(screen.getByRole('button', { name: /^Link$/ }))
    await screen.findByLabelText('Link URL')
    await user.keyboard('{Escape}')
    expect(editor._chainCalls).not.toContain('setLink')
    expect(editor._chainCalls).not.toContain('unsetLink')
    expect(screen.queryByLabelText('Link URL')).toBeNull()
  })
})
