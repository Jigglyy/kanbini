import { useEffect, useMemo, useRef, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ArrowRight, LayoutGrid, Search } from 'lucide-react'
import type { BoardSummary, SearchHit } from '@kanbini/shared'
import { ipc } from '../lib/ipc'
import { cn } from '../lib/utils'
import { Modal } from './ui/modal'

// Global command palette (M4-D). Opens on Ctrl/Cmd+K anywhere in the
// app. Two intermixed sections:
//
//  • Cards - substring search across every (non-archived, non-closed)
//    card by title, description, and label name. IPC fires debounced
//    so each keystroke doesn't round-trip the DB.
//  • Boards - fast board switcher. Filters by the same query when
//    non-empty; shows every (non-archived) board when the query is
//    empty so an empty palette is still useful as a quick board jump.
//
// Keyboard-first: Up/Down navigate, Enter activates, Esc closes
// (Modal owns Esc). Click also activates. The selection wraps around
// at the ends so a single Up from index 0 lands on the last item.

interface Props {
  open: boolean
  onClose: () => void
  boards: BoardSummary[]
  /** Navigate to a board, optionally opening a card detail on arrival. */
  onActivate: (boardId: string, cardId?: string) => void
}

/** Tiny debounce hook - keeps the search IPC from firing on every
 *  keystroke. 120 ms feels live without spamming. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return v
}

type PaletteItem =
  | { kind: 'card'; hit: SearchHit }
  | { kind: 'board'; board: BoardSummary }

export function CommandPalette({ open, onClose, boards, onActivate }: Props) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const debounced = useDebounced(query, 120)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const qTrim = debounced.trim()

  // Reset query + selection every time the palette opens, and put
  // focus in the input after the portal renders.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelected(0)
    queueMicrotask(() => inputRef.current?.focus())
  }, [open])

  const {
    data: hits = [],
    isFetching,
    isError
  } = useQuery({
    queryKey: ['search', qTrim],
    queryFn: () => ipc.searchCards({ query: qTrim, limit: 50 }),
    enabled: open && qTrim.length > 0,
    staleTime: 5_000,
    // Hold the previous results visible while the next query is in
    // flight - otherwise each keystroke clears `hits` to [] for one
    // render and the list flickers between "results" and "Searching…".
    placeholderData: keepPreviousData
  })

  // Boards section: substring match on name (cheap, client-side).
  // Empty query shows every non-archived board so the palette doubles
  // as a board switcher without typing.
  const visibleBoards = useMemo(() => {
    const qLower = qTrim.toLowerCase()
    return boards
      .filter((b) => !b.archived)
      .filter((b) => qLower === '' || b.name.toLowerCase().includes(qLower))
      .slice(0, 12)
  }, [boards, qTrim])

  const items: PaletteItem[] = useMemo(
    () => [
      ...hits.map((hit) => ({ kind: 'card' as const, hit })),
      ...visibleBoards.map((board) => ({ kind: 'board' as const, board }))
    ],
    [hits, visibleBoards]
  )

  // Clamp selection whenever the items list shrinks (e.g., a new
  // query trimmed the result count below the previous index).
  useEffect(() => {
    setSelected((s) => (items.length === 0 ? 0 : Math.min(s, items.length - 1)))
  }, [items.length])

  // Scroll the selected row into view on keyboard nav.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-row="${selected}"]`
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const activate = (item: PaletteItem): void => {
    if (item.kind === 'card') {
      onActivate(item.hit.boardId, item.hit.cardId)
    } else {
      onActivate(item.board.id)
    }
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (items.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((s) => (s + 1) % items.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((s) => (s - 1 + items.length) % items.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = items[selected]
      if (item) activate(item)
    }
  }

  // Re-derive section indices from the same flat `items` so the
  // section headers don't double-count when the cards list is empty.
  const cardCount = hits.length
  const boardStart = cardCount

  return (
    <Modal open={open} onClose={onClose} label="Command palette">
      <div className="flex flex-col">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search cards or jump to a board…"
            className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <kbd className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
            Esc
          </kbd>
        </div>
        <div
          ref={listRef}
          className="max-h-[60vh] overflow-y-auto px-2 py-2"
        >
          {isError && (
            <p className="px-2 py-3 text-xs text-red-400">
              Couldn't run that search.
            </p>
          )}
          {/* Hide the empty panel while a search is in flight so a
              fast query doesn't flash "No matches" between keystrokes
              (keepPreviousData keeps the prior list visible). */}
          {!isError && !isFetching && items.length === 0 && (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              {qTrim === '' ? 'No boards yet.' : 'No matches.'}
            </p>
          )}

          {cardCount > 0 && <SectionHeader>Cards</SectionHeader>}
          {hits.map((hit, i) => (
            <Row
              key={`c-${hit.cardId}`}
              index={i}
              active={selected === i}
              onSelect={() => setSelected(i)}
              onActivate={() => activate({ kind: 'card', hit })}
            >
              <CardHit hit={hit} />
            </Row>
          ))}

          {visibleBoards.length > 0 && (
            <SectionHeader>
              {qTrim === '' ? 'Jump to board' : 'Boards'}
            </SectionHeader>
          )}
          {visibleBoards.map((board, i) => {
            const idx = boardStart + i
            return (
              <Row
                key={`b-${board.id}`}
                index={idx}
                active={selected === idx}
                onSelect={() => setSelected(idx)}
                onActivate={() => activate({ kind: 'board', board })}
              >
                <BoardRow board={board} />
              </Row>
            )
          })}
        </div>
      </div>
    </Modal>
  )
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-2 px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground first:mt-0">
      {children}
    </div>
  )
}

function Row({
  index,
  active,
  onSelect,
  onActivate,
  children
}: {
  index: number
  active: boolean
  onSelect: () => void
  onActivate: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      data-row={index}
      // mouseEnter (not mouseMove) so micro-movements over a parked
      // mouse don't keep re-asserting selection over the keyboard's
      // cursor - the user can Up/Down past the mouse cursor and the
      // selection only snaps back if they move to a different row.
      onMouseEnter={onSelect}
      onClick={onActivate}
      className={cn(
        'flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm transition-colors',
        active ? 'bg-accent text-foreground' : 'text-foreground hover:bg-muted'
      )}
    >
      {children}
    </button>
  )
}

function CardHit({ hit }: { hit: SearchHit }) {
  return (
    <>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{hit.title}</span>
          {hit.matchedLabels.map((name) => (
            <span
              key={name}
              className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
            >
              {name}
            </span>
          ))}
        </div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">
          {hit.boardName} · {hit.listName}
        </div>
        {hit.descriptionSnippet && (
          <div className="mt-1 line-clamp-2 text-xs text-muted-foreground/80 wrap-anywhere">
            {hit.descriptionSnippet}
          </div>
        )}
      </div>
      <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
    </>
  )
}

function BoardRow({ board }: { board: BoardSummary }) {
  return (
    <>
      <span
        aria-hidden
        className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground"
        style={board.color ? { backgroundColor: board.color } : undefined}
      >
        {!board.color && <LayoutGrid className="size-3.5" />}
      </span>
      <span className="min-w-0 flex-1 truncate">{board.name}</span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {board.cardCount} {board.cardCount === 1 ? 'card' : 'cards'}
      </span>
    </>
  )
}
