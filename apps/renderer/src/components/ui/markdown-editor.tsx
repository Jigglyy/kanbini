import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  EditorContent,
  useEditor,
  useEditorState,
  type Editor
} from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import Typography from '@tiptap/extension-typography'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { common, createLowlight } from 'lowlight'
import { Markdown } from 'tiptap-markdown'
import { Popover } from './popover'
import {
  Bold,
  Code,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Quote,
  Redo2,
  Strikethrough,
  Undo2
} from 'lucide-react'

// WYSIWYG editor that stores Markdown (ADR-0016). One-way init from
// `value`; emits `onChange(md)` debounced. External refetches don't
// stomp in-flight edits because we only setContent on mount.

const lowlight = createLowlight(common)

/** Shared extension set so MarkdownView renders comments identically
 *  to how MarkdownEditor edits them. Exported for the comment
 *  composer (comments.tsx) which uses TipTap directly. */
export function buildExtensions(placeholder?: string) {
  return [
    StarterKit.configure({ codeBlock: false, link: false }),
    CodeBlockLowlight.configure({ lowlight }),
    Link.configure({
      openOnClick: false,
      autolink: true,
      HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' }
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Placeholder.configure({ placeholder: placeholder ?? '' }),
    Typography,
    Markdown.configure({
      html: false,
      breaks: true,
      transformPastedText: true,
      transformCopiedText: true
    })
  ]
}

// Pull the current Markdown string out of an editor instance. The
// tiptap-markdown plugin installs `markdown` on `editor.storage` at
// runtime but the type isn't augmented, so reach for it via index.
function getMarkdown(editor: Editor): string {
  const storage = (editor.storage as unknown as Record<string, unknown>)[
    'markdown'
  ] as { getMarkdown: () => string } | undefined
  return storage?.getMarkdown() ?? ''
}

export function MarkdownEditor({
  value,
  onChange,
  placeholder = 'Add a description…',
  minRows = 6,
  autoFocus = false,
  autoHideToolbar = false
}: {
  value: string
  onChange: (md: string) => void
  placeholder?: string
  minRows?: number
  autoFocus?: boolean
  /** When true the toolbar shows only while the editor is focused or
   *  has content - used for the comment composer. */
  autoHideToolbar?: boolean
}) {
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  // Track pending markdown so unmount can flush it. Without this, a
  // user typing then immediately leaving edit mode (or closing the
  // modal) loses the last keystrokes since the 500 ms debounce gets
  // cancelled in the cleanup.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<string | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      if (pending.current !== null) {
        onChangeRef.current(pending.current)
        pending.current = null
      }
    },
    []
  )

  const editor = useEditor({
    extensions: buildExtensions(placeholder),
    content: value,
    // NOT TipTap's `autofocus` option - it focuses AND scrolls the
    // contenteditable into view, which nudges the card-detail modal's
    // scroll every time the description enters edit mode (the card
    // visibly creeps upward over repeated open/close). We focus manually
    // below with `scrollIntoView: false`. Comments never autofocus, which
    // is why they don't drift.
    autofocus: false,
    editorProps: {
      attributes: {
        class:
          'tiptap prose prose-invert max-w-none px-3 py-2 focus:outline-none'
      }
    },
    onUpdate: ({ editor }) => {
      const md = getMarkdown(editor)
      pending.current = md
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        onChangeRef.current(md)
        pending.current = null
      }, 500)
    }
  })

  // Focus-on-mount without scrolling (see the autofocus note above).
  // useLayoutEffect (not useEffect) so it runs in the commit phase
  // BEFORE MarkdownField's scroll-restore layout effect - parent effects
  // run after child effects, so the restore gets the final word on the
  // scroll position even if focusing the caret nudges it. `autoFocus` is
  // fixed for the editor's lifetime (set when the field enters edit mode).
  useLayoutEffect(() => {
    if (autoFocus && editor) {
      editor.commands.focus('end', { scrollIntoView: false })
    }
  }, [autoFocus, editor])

  // Track focused/empty for auto-hide toolbar. `useEditorState` is the
  // only reliable way to read these in TipTap v3 (see comment composer
  // and ADR-0016 follow-up).
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? { focused: e.isFocused, empty: e.isEmpty }
        : { focused: false, empty: true }
  })

  if (!editor) return null
  const showToolbar = !autoHideToolbar || state.focused || !state.empty
  return (
    <div className="flex flex-col rounded-md border border-border bg-background">
      {showToolbar && <RevealingToolbar editor={editor} />}
      <EditorContent
        editor={editor}
        style={{ minHeight: `${minRows * 1.5}rem` }}
      />
    </div>
  )
}

/** The formatting Toolbar wrapped in the mount-reveal animation
 *  (ADR-0058). `toolbar-reveal` tweens grid-template-rows 0fr→1fr on
 *  mount so the row eases open instead of snapping (index.css); the
 *  inner `overflow-hidden` is what the auto-height technique clips
 *  against. Used by BOTH the description editor (here) and the comment
 *  composer (comments.tsx) so the reveal is consistent - keep mounting
 *  it conditionally (it should be absent, not just collapsed, when the
 *  toolbar is hidden). */
export function RevealingToolbar({ editor }: { editor: Editor }) {
  return (
    <div className="toolbar-reveal grid grid-rows-[1fr]">
      <div className="overflow-hidden">
        <Toolbar editor={editor} />
      </div>
    </div>
  )
}

export function Toolbar({ editor }: { editor: Editor }) {
  // TipTap v3: `editor.isActive(...)` is reactive only via
  // useEditorState - subscribing here keeps the toolbar's active-state
  // highlights in sync with the caret.
  const a = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            bold: e.isActive('bold'),
            italic: e.isActive('italic'),
            strike: e.isActive('strike'),
            code: e.isActive('code'),
            h1: e.isActive('heading', { level: 1 }),
            h2: e.isActive('heading', { level: 2 }),
            h3: e.isActive('heading', { level: 3 }),
            bulletList: e.isActive('bulletList'),
            orderedList: e.isActive('orderedList'),
            taskList: e.isActive('taskList'),
            blockquote: e.isActive('blockquote'),
            codeBlock: e.isActive('codeBlock'),
            link: e.isActive('link')
          }
        : null
  })
  const cmd = (fn: () => boolean): void => {
    fn()
    editor.commands.focus()
  }
  // `onMouseDown` preventDefault keeps focus inside the editor while
  // clicking a toolbar button, so the auto-hide toolbar doesn't flicker
  // and the caret position stays put.
  const hold = (e: React.MouseEvent): void => {
    e.preventDefault()
  }
  return (
    <div
      onMouseDown={hold}
      className="flex flex-wrap items-center gap-0.5 border-b border-border px-1 py-1"
    >
      <Btn on={a?.bold} onClick={() => cmd(() => editor.chain().focus().toggleBold().run())} title="Bold (Ctrl+B)"><Bold className="size-4" /></Btn>
      <Btn on={a?.italic} onClick={() => cmd(() => editor.chain().focus().toggleItalic().run())} title="Italic (Ctrl+I)"><Italic className="size-4" /></Btn>
      <Btn on={a?.strike} onClick={() => cmd(() => editor.chain().focus().toggleStrike().run())} title="Strikethrough"><Strikethrough className="size-4" /></Btn>
      <Btn on={a?.code} onClick={() => cmd(() => editor.chain().focus().toggleCode().run())} title="Inline code"><Code className="size-4" /></Btn>
      <Sep />
      <Btn on={a?.h1} onClick={() => cmd(() => editor.chain().focus().toggleHeading({ level: 1 }).run())} title="Heading 1"><Heading1 className="size-4" /></Btn>
      <Btn on={a?.h2} onClick={() => cmd(() => editor.chain().focus().toggleHeading({ level: 2 }).run())} title="Heading 2"><Heading2 className="size-4" /></Btn>
      <Btn on={a?.h3} onClick={() => cmd(() => editor.chain().focus().toggleHeading({ level: 3 }).run())} title="Heading 3"><Heading3 className="size-4" /></Btn>
      <Sep />
      <Btn on={a?.bulletList} onClick={() => cmd(() => editor.chain().focus().toggleBulletList().run())} title="Bullet list"><List className="size-4" /></Btn>
      <Btn on={a?.orderedList} onClick={() => cmd(() => editor.chain().focus().toggleOrderedList().run())} title="Numbered list"><ListOrdered className="size-4" /></Btn>
      <Btn on={a?.taskList} onClick={() => cmd(() => editor.chain().focus().toggleTaskList().run())} title="Task list"><ListChecks className="size-4" /></Btn>
      <Sep />
      <Btn on={a?.blockquote} onClick={() => cmd(() => editor.chain().focus().toggleBlockquote().run())} title="Blockquote"><Quote className="size-4" /></Btn>
      <Btn on={a?.codeBlock} onClick={() => cmd(() => editor.chain().focus().toggleCodeBlock().run())} title="Code block"><Code2 className="size-4" /></Btn>
      <LinkButton editor={editor} active={a?.link} />
      <Btn onClick={() => cmd(() => editor.chain().focus().setHorizontalRule().run())} title="Horizontal rule"><Minus className="size-4" /></Btn>
      <Sep />
      <Btn onClick={() => cmd(() => editor.chain().focus().undo().run())} title="Undo (Ctrl+Z)"><Undo2 className="size-4" /></Btn>
      <Btn onClick={() => cmd(() => editor.chain().focus().redo().run())} title="Redo (Ctrl+Y)"><Redo2 className="size-4" /></Btn>
    </div>
  )
}

function Btn({
  on,
  onClick,
  title,
  children
}: {
  on?: boolean
  onClick: () => void
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground ${
        on ? 'bg-muted text-foreground' : ''
      }`}
    >
      {children}
    </button>
  )
}

function Sep() {
  return <span className="mx-1 h-5 w-px bg-border" />
}

/** The toolbar's Link control. A small Popover with a URL input -
 *  NOT `window.prompt`, which Electron disables in the renderer (so the
 *  old prompt-based button silently did nothing in the packaged app).
 *  ProseMirror keeps its selection across the input's focus steal, so
 *  `chain().focus().extendMarkRange('link').setLink()` still targets the
 *  word/selection the caret was on when the popover opened. */
function LinkButton({ editor, active }: { editor: Editor; active?: boolean }) {
  const [value, setValue] = useState('')
  const applyLink = (close: () => void): void => {
    const url = value.trim()
    const chain = editor.chain().focus().extendMarkRange('link')
    if (url === '') chain.unsetLink().run()
    else chain.setLink({ href: url }).run()
    close()
  }
  return (
    <Popover
      width={260}
      trigger={({ toggle }) => (
        <button
          type="button"
          // Keep the editor selection while opening the popover (mirrors
          // the toolbar root's hold) - without it the caret collapses.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const prev =
              (editor.getAttributes('link').href as string | undefined) ?? ''
            setValue(prev)
            toggle()
          }}
          title="Link"
          aria-label="Link"
          className={`rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground ${
            active ? 'bg-muted text-foreground' : ''
          }`}
        >
          <LinkIcon className="size-4" />
        </button>
      )}
    >
      {(close) => (
        <div className="flex flex-col gap-2">
          <input
            autoFocus
            type="url"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                applyLink(close)
              }
            }}
            placeholder="https://example.com"
            aria-label="Link URL"
            className="rounded border border-border bg-background px-2 py-1 text-sm focus:border-ring focus:outline-none"
          />
          <div className="flex items-center justify-between gap-2">
            {active ? (
              <button
                type="button"
                onClick={() => {
                  editor.chain().focus().extendMarkRange('link').unsetLink().run()
                  close()
                }}
                className="rounded px-2 py-1 text-xs text-red-400 hover:text-red-300"
              >
                Remove
              </button>
            ) : (
              <span />
            )}
            <button
              type="button"
              onClick={() => applyLink(close)}
              className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90"
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </Popover>
  )
}

/** Read-only renderer for stored Markdown (e.g. comment bodies).
 *  Uses the same extensions as the editor so rendering is identical. */
export function MarkdownView({ value }: { value: string }) {
  const editor = useEditor({
    extensions: buildExtensions(),
    content: value,
    editable: false,
    editorProps: {
      attributes: { class: 'tiptap prose prose-invert max-w-none' }
    }
  })
  // `useEditor` captures `content` at mount; subsequent `value`
  // prop changes don't reach the editor without an explicit
  // `setContent`. This matters whenever the body starts as '' (e.g.
  // an async-loaded value) and flips to real text after mount -
  // without this effect the editor stays initialised with the empty
  // string and renders nothing. Safe in read-only mode because
  // there's no user edit state to clobber.
  useEffect(() => {
    if (!editor) return
    editor.commands.setContent(value)
  }, [editor, value])
  if (!editor) return null
  return <EditorContent editor={editor} />
}

/** Description-style field: shows rendered Markdown until the user
 *  clicks in, then swaps to the full MarkdownEditor (with toolbar +
 *  autosave). Exits edit mode on Escape or outside-click; the editor's
 *  unmount-flush guarantees the latest keystrokes still save. */
export function MarkdownField({
  value,
  onChange,
  placeholder = 'Add a description…',
  minRows = 6
}: {
  value: string
  onChange: (md: string) => void
  placeholder?: string
  minRows?: number
}) {
  const [editing, setEditing] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Preserve the enclosing scroll container's position across the
  // display↔edit swap. The editor is taller than the rendered view (the
  // toolbar appears + a min-height), and that height change - plus
  // focusing the caret and the browser's scroll-anchoring - used to
  // drift the card-detail modal's scroll UPWARD a little on every
  // open/close (it crept the card "way up" over repeats). Capture the
  // scroll position at the toggle, restore it synchronously after the DOM
  // swaps (before paint). Comments don't use MarkdownField, which is why
  // they never drifted.
  const scrollFix = useRef<{ el: HTMLElement; top: number } | null>(null)
  const toggleEditing = (next: boolean): void => {
    scrollFix.current = null
    let node: HTMLElement | null = rootRef.current
    while (node) {
      const oy = getComputedStyle(node).overflowY
      if (
        (oy === 'auto' || oy === 'scroll') &&
        node.scrollHeight > node.clientHeight
      ) {
        scrollFix.current = { el: node, top: node.scrollTop }
        break
      }
      node = node.parentElement
    }
    setEditing(next)
  }
  useLayoutEffect(() => {
    const fix = scrollFix.current
    if (fix) {
      fix.el.scrollTop = fix.top
      scrollFix.current = null
    }
  }, [editing])

  useEffect(() => {
    if (!editing) return
    const onDown = (e: PointerEvent): void => {
      const target = e.target as HTMLElement | null
      if (rootRef.current?.contains(target ?? null)) return
      // The toolbar's Link control opens a Popover portaled to <body>
      // (outside rootRef). A click in that overlay must NOT be treated
      // as "outside" - otherwise it would tear down the editor (and the
      // popover) mid-edit. Same for any other editor-spawned overlay.
      if (target?.closest('[data-overlay]')) return
      toggleEditing(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // Overlay-aware, like App.tsx's Escape: if the Link popover (or any
      // editor overlay) is open, the FIRST Escape closes that surface
      // (its own handler), not the whole editor - a second Escape exits.
      if (document.querySelector('[data-overlay]')) return
      toggleEditing(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [editing])

  if (!editing) {
    const hasContent = value.trim().length > 0
    return (
      <div
        ref={rootRef}
        role="button"
        tabIndex={0}
        onClick={() => toggleEditing(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggleEditing(true)
          }
        }}
        className="cursor-text rounded-md border border-transparent px-3 py-2 hover:border-border focus:border-ring focus:outline-none"
        style={{ minHeight: `${minRows * 1.5}rem` }}
      >
        {hasContent ? (
          <MarkdownView value={value} />
        ) : (
          <span className="text-sm text-muted-foreground">{placeholder}</span>
        )}
      </div>
    )
  }
  return (
    <div ref={rootRef}>
      <MarkdownEditor
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        minRows={minRows}
        autoFocus
      />
    </div>
  )
}
