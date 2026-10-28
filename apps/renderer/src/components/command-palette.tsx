import { useEffect, useMemo, useRef, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ArrowRight, LayoutGrid, Search } from 'lucide-react'
import { formatCardNumber, type BoardSummary, type SearchHit } from '@kanbini/shared'
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
// Keyboard-first: Up/Down navigate, Enter shows the card on its board
// (Ctrl/Cmd+Enter opens it), Esc closes (Modal owns Esc). Click shows,
// Ctrl/Cmd+click opens. The selection wraps around at the ends so a
// single Up from index 0 lands on the last item.
//
// What's highlighted is always what Enter takes: rows render from the
// same `items` list Enter reads, every new set of results starts on the
// first one, a row that merely appears under a resting mouse doesn't
// grab the selection (only real pointer movement does), and an Enter
// pressed before the results for the typed text arrive waits for them
// instead of acting on the previous (debounced) results.

interface Props {
  open: boolean
  onClose: () => void
  boards: BoardSummary[]
  /** The board on screen, if any. Its cards come first in the results
   *  (any match, ahead of another board's exact #N), so "#3" + Enter
   *  shows this board's #3. */
  currentBoardId?: string | null
  /** Navigate to a board; with a card, point that card out on arrival
   *  (scroll + glow, keyboard focus; Enter then opens it), or open it
   *  straight away with `{ open: true }` (Ctrl/Cmd+Enter or -click). */
  onActivate: (boardId: string, cardId?: string, opts?: { open: true }) => void
}

/** How a row is activated: point the card out, or open it. */
type Mode = 'show' | 'open'

const NO_HITS: SearchHit[] = []
const IS_MAC =
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent)

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

export function CommandPalette({
  open,
  onClose,
  boards,
  currentBoardId = null,
  onActivate
}: Props) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  // Enter pressed while the results don't match the typed text yet;
  // run once they do (see `ready`).
  const [pending, setPending] = useState<Mode | null>(null)
  // Last pointer position seen over a row: selection only follows the
  // mouse when it actually moves (see `onRowMouseMove`).
  const lastPointer = useRef<{ x: number; y: number } | null>(null)
  const debounced = useDebounced(query, 120)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const qTrim = debounced.trim()

  // Reset query + selection when the palette CLOSES, so it always opens
  // fresh. (Resetting on open ran in an effect after the input was
  // already on screen, wiping anything typed in that instant.) Put focus
  // in the input after the portal renders.
  useEffect(() => {
    if (open) {
      queueMicrotask(() => inputRef.current?.focus())
      return
    }
    setQuery('')
    setSelected(0)
    setPending(null)
    lastPointer.current = null
  }, [open])

  // Search ranks the on-screen board's cards first (before its result
  // limit), so the order it returns is the order shown and used.
  const preferBoardId = currentBoardId ?? undefined
  const { data, isFetching, isError, isPlaceholderData, status } = useQuery({
    queryKey: ['search', qTrim, preferBoardId ?? null],
    queryFn: () => ipc.searchCards({ query: qTrim, limit: 50, preferBoardId }),
    enabled: open && qTrim.length > 0,
    staleTime: 5_000,
    // Hold the previous results visible while the next query is in
    // flight - otherwise each keystroke clears `hits` to [] for one
    // render and the list flickers between "results" and "Searching…".
    placeholderData: keepPreviousData
  })
  const hits = data ?? NO_HITS
  // The results on screen are for the text in the box: the debounce has
  // caught up, and the cards came back for THIS query (not the previous
  // one kept on screen by keepPreviousData).
  const ready =
    query.trim() === qTrim &&
    (qTrim === '' || isError || (status === 'success' && !isPlaceholderData))

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

  // Every new set of results starts on the first one.
  useEffect(() => {
    setSelected(0)
  }, [qTrim, data])
  // Clamp selection whenever the items list shrinks (e.g., the board
  // list changed under an open palette).
  useEffect(() => {
    setSelected((s) => (items.length === 0 ? 0 : Math.min(s, items.length - 1)))
  }, [items.length])
  // A pending Enter runs as soon as the results match what was typed -
  // on the first result, which is where a new search starts.
  useEffect(() => {
    if (!pending || !ready) return
    setPending(null)
    const first = items[0]
    if (first) activate(first, pending)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, ready, items])

  // Scroll the selected row into view on keyboard nav.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-row="${selected}"]`
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  function activate(item: PaletteItem, mode: Mode): void {
    if (item.kind === 'card') {
      if (mode === 'open') onActivate(item.hit.boardId, item.hit.cardId, { open: true })
      else onActivate(item.hit.boardId, item.hit.cardId)
    } else {
      onActivate(item.board.id)
    }
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const mode: Mode = e.ctrlKey || e.metaKey ? 'open' : 'show'
      if (!ready) {
        setPending(mode)
        return
      }
      const item = items[selected]
      if (item) activate(item, mode)
      return
    }
    if (items.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((s) => (s + 1) % items.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((s) => (s - 1 + items.length) % items.length)
    }
  }

  // Select a row only when the mouse really moved over it. A row that
  // renders under a resting pointer gets mouseenter and a mousemove at
  // the same spot from the browser; letting those select made Enter
  // take whatever row appeared under the mouse. The first event after
  // opening just records where the pointer is. And only moving onto a
  // DIFFERENT row re-selects, so arrowing past the mouse isn't undone by
  // a tiny nudge of it.
  const lastMouseRow = useRef<number | null>(null)
  useEffect(() => {
    lastMouseRow.current = null
  }, [qTrim, data])
  const onRowMouseMove = (e: React.MouseEvent, index: number): void => {
    const last = lastPointer.current
    lastPointer.current = { x: e.clientX, y: e.clientY }
    if (!last || (last.x === e.clientX && last.y === e.clientY)) return
    if (lastMouseRow.current === index) return
    lastMouseRow.current = index
    setSelected(index)
  }

  // Render straight from `items` - the list Enter reads - so the rows
  // and Enter can't disagree on order.
  const cardItems = items.filter(
    (i): i is Extract<PaletteItem, { kind: 'card' }> => i.kind === 'card'
  )
  const boardItems = items.filter(
    (i): i is Extract<PaletteItem, { kind: 'board' }> => i.kind === 'board'
  )
  const cardCount = cardItems.length
  const boardStart = cardCount
  const modeFromClick = (e: React.MouseEvent): Mode =>
    e.ctrlKey || e.metaKey ? 'open' : 'show'
  const selectedItem = items[selected]

  return (
    <Modal open={open} onClose={onClose} label="Command palette">
      <div className="flex flex-col">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setPending(null)
            }}
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
          {cardItems.map((item, i) => (
            <Row
              key={`c-${item.hit.cardId}`}
              index={i}
              active={selected === i}
              onMouseMove={(e) => onRowMouseMove(e, i)}
              onActivate={(e) => activate(item, modeFromClick(e))}
            >
              <CardHit hit={item.hit} />
            </Row>
          ))}

          {boardItems.length > 0 && (
            <SectionHeader>
              {qTrim === '' ? 'Jump to board' : 'Boards'}
            </SectionHeader>
          )}
          {boardItems.map((item, i) => {
            const idx = boardStart + i
            return (
              <Row
                key={`b-${item.board.id}`}
                index={idx}
                active={selected === idx}
                onMouseMove={(e) => onRowMouseMove(e, idx)}
                onActivate={(e) => activate(item, modeFromClick(e))}
              >
                <BoardRow board={item.board} />
              </Row>
            )
          })}
        </div>
        {selectedItem && <KeyHints card={selectedItem.kind === 'card'} />}
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

/** The keys that work here, under the results. */
function KeyHints({ card }: { card: boolean }) {
  const mod = IS_MAC ? '⌘' : 'Ctrl'
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
      <span>
        <Key>↑</Key> <Key>↓</Key> to choose
      </span>
      {card ? (
        <>
          <span>
            <Key>Enter</Key> to show it on the board
          </span>
          <span>
            <Key>{mod}+Enter</Key> to open it
          </span>
        </>
      ) : (
        <span>
          <Key>Enter</Key> to go to the board
        </span>
      )}
    </div>
  )
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-background px-1 py-px font-sans text-[10px] text-foreground">
      {children}
    </kbd>
  )
}

function Row({
  index,
  active,
  onMouseMove,
  onActivate,
  children
}: {
  index: number
  active: boolean
  onMouseMove: (e: React.MouseEvent) => void
  onActivate: (e: React.MouseEvent) => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      data-row={index}
      aria-current={active ? 'true' : undefined}
      onMouseMove={onMouseMove}
      onClick={onActivate}
      // No CSS :hover tint: selection follows real mouse movement, so the
      // one highlighted row is always the row Enter takes (a hover tint
      // on a row under a resting mouse would show a second "choice").
      // The selected row gets a clear tint plus an accent bar, readable
      // in both themes.
      className={cn(
        'relative flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm text-foreground',
        active &&
          'bg-primary/15 before:absolute before:inset-y-1.5 before:left-0 before:w-1 before:rounded-full before:bg-primary'
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
          {hit.number > 0 && (
            <>
              <span className="tabular-nums">{formatCardNumber(hit.number)}</span>
              {' · '}
            </>
          )}
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
