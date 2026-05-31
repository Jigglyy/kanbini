import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import { X } from 'lucide-react'
import type {
  BoardView,
  CardView,
  CommentView,
  Mutation
} from '@kanbini/shared'
import type { Optimistic } from '../hooks/useBoardMutation'
import {
  buildExtensions,
  MarkdownView,
  RevealingToolbar
} from './ui/markdown-editor'

// Card-detail comments: composer at top, thread below (newest first
// per getBoardView). Author 'ai' renders with a distinct chip - M3's
// MCP-posted comments will surface there. Composer reuses the
// renderer's TipTap stack (same extensions) so the input renders /
// pastes Markdown identically to the description editor.

type Apply = (m: Mutation, o: Optimistic) => void

const mapCard = (
  b: BoardView,
  cardId: string,
  fn: (c: CardView) => CardView
): BoardView => ({
  ...b,
  lists: b.lists.map((l) => ({
    ...l,
    cards: l.cards.map((c) => (c.id === cardId ? fn(c) : c))
  }))
})

export function Comments({
  card,
  apply
}: {
  card: CardView
  apply: Apply
}) {
  const add = (body: string): void => {
    const temp: CommentView = {
      id: `tmp-${crypto.randomUUID()}`,
      body,
      author: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    apply({ type: 'comment.create', cardId: card.id, body }, (b) =>
      mapCard(b, card.id, (c) => ({
        ...c,
        comments: [temp, ...c.comments]
      }))
    )
  }
  const del = (id: string): void => {
    apply({ type: 'comment.delete', id }, (b) =>
      mapCard(b, card.id, (c) => ({
        ...c,
        comments: c.comments.filter((x) => x.id !== id)
      }))
    )
  }

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-muted-foreground">Comments</h3>
      <CommentComposer onSubmit={add} />
      {card.comments.length === 0 && (
        <p className="text-xs text-muted-foreground/70">No comments yet.</p>
      )}
      {card.comments.map((cm) => (
        <CommentItem key={cm.id} comment={cm} onDelete={() => del(cm.id)} />
      ))}
    </section>
  )
}

function CommentComposer({ onSubmit }: { onSubmit: (md: string) => void }) {
  const editor = useEditor({
    extensions: buildExtensions('Write a comment…'),
    content: '',
    editorProps: {
      attributes: {
        class:
          'tiptap prose prose-invert max-w-none px-3 py-2 focus:outline-none'
      }
    }
  })
  // TipTap v3's `useEditor` no longer re-renders the component on every
  // transaction - `editor.isEmpty` would stay stale. `useEditorState`
  // subscribes properly so the Comment button enables once the
  // composer has content (and the toolbar reveals on focus / typing).
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? { empty: e.isEmpty, focused: e.isFocused }
        : { empty: true, focused: false }
  })
  if (!editor) return null

  const submit = (): void => {
    const storage = (editor.storage as unknown as Record<string, unknown>)[
      'markdown'
    ] as { getMarkdown: () => string } | undefined
    const md = (storage?.getMarkdown() ?? '').trim()
    if (!md) return
    onSubmit(md)
    editor.commands.clearContent()
    editor.commands.blur()
  }

  // Toolbar appears once the user engages with the field; the active
  // button row stays mounted while content is non-empty so clicking a
  // formatting button never collapses the toolbar mid-edit.
  const showToolbar = state.focused || !state.empty

  return (
    <div className="rounded-md border border-border bg-background">
      {showToolbar && <RevealingToolbar editor={editor} />}
      <EditorContent editor={editor} />
      {showToolbar && (
        <div className="flex items-center justify-end border-t border-border px-2 py-1.5">
          <button
            onClick={submit}
            disabled={state.empty}
            className={`rounded px-3 py-1 text-sm ${
              state.empty
                ? 'cursor-not-allowed bg-muted text-muted-foreground'
                : 'bg-primary text-primary-foreground hover:bg-primary/90'
            }`}
          >
            Comment
          </button>
        </div>
      )}
    </div>
  )
}

function CommentItem({
  comment,
  onDelete
}: {
  comment: CommentView
  onDelete: () => void
}) {
  const isAi = comment.author === 'ai'
  return (
    <div className="group/comment flex flex-col gap-1 rounded-md border border-border bg-background/40 p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
            isAi ? 'bg-primary/20 text-primary' : 'bg-muted text-foreground'
          }`}
        >
          {isAi ? 'AI' : 'You'}
        </span>
        <span>
          {new Date(comment.createdAt).toLocaleString(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short'
          })}
        </span>
        <button
          aria-label="Delete comment"
          onClick={onDelete}
          className="ml-auto opacity-0 transition-opacity group-hover/comment:opacity-100"
        >
          <X className="size-3.5 text-muted-foreground hover:text-foreground" />
        </button>
      </div>
      <MarkdownView value={comment.body} />
    </div>
  )
}
