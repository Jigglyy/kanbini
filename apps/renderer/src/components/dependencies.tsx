import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, Check, Circle, Lock, Plus, X } from 'lucide-react'
import {
  formatCardNumber,
  isOpenBlocker,
  type CardRef,
  type CardView,
  type Mutation,
  type SearchHit
} from '@kanbini/shared'
import { boardsRootKey } from '../hooks/useBoard'
import { ipc } from '../lib/ipc'
import { cn } from '../lib/utils'

// "Waiting on" links between cards (card_dependency). Two surfaces:
//   - BlockedBadge: the meta-row marker on a card preview while any card
//     it waits on is still open.
//   - CardDependencies: the card-detail section listing what the card
//     waits on and what's waiting on it, with remove buttons and an
//     inline search to add a card to wait on (any board).
// Writes go straight through ipc.mutate (no optimistic projection: the
// far end's title / board / list only exist server-side) and the
// `changed` broadcast refetches the board. A rejected add (self-link or
// a loop) surfaces its reason inline instead of failing silently.

/** Marker for the card preview's meta row. Hidden on a completed card:
 *  once it's done, what it was waiting on no longer matters. */
export function BlockedBadge({ card }: { card: CardView }) {
  if (card.completed) return null
  const open = card.blockedBy.filter(isOpenBlocker)
  if (open.length === 0) return null
  return (
    <span
      className="flex w-fit items-center gap-1 text-[11px] font-medium text-warning"
      title={`Waiting on ${open.map((r) => `"${r.title}"`).join(', ')}`}
    >
      <Lock className="size-3" aria-hidden />
      Blocked
    </span>
  )
}

/** Turn a server rejection into something a person can act on. */
function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (/loop/i.test(msg)) {
    return "That card is already waiting on this one, so they can't wait on each other."
  }
  if (/itself/i.test(msg)) return "A card can't wait on itself."
  if (/not found/i.test(msg)) return 'That card no longer exists.'
  return "Couldn't update the link. Try again."
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return v
}

export function CardDependencies({
  card,
  boardId,
  onOpenCard
}: {
  card: CardView
  boardId: string
  /** Open a linked card (same board: swap the detail; other board:
   *  navigate there). */
  onOpenCard: (boardId: string, cardId: string) => void
}) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // A different card in the same detail modal starts clean.
  useEffect(() => {
    setAdding(false)
    setError(null)
  }, [card.id])

  async function run(m: Mutation): Promise<boolean> {
    setBusy(true)
    setError(null)
    try {
      await ipc.mutate(m)
      await qc.invalidateQueries({ queryKey: boardsRootKey })
      return true
    } catch (e) {
      setError(friendlyError(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  // Not offered: the card itself, what it already waits on, and what
  // already waits on IT (picking one of those is a guaranteed loop).
  // Longer loops are still caught server-side and explained.
  const exclude = new Set([
    card.id,
    ...card.blockedBy.map((r) => r.cardId),
    ...card.blocking.map((r) => r.cardId)
  ])

  return (
    <section className="flex flex-col gap-2" aria-label="Waiting on">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-muted-foreground">Waiting on</h3>
        {!adding && (
          <button
            type="button"
            onClick={() => {
              setError(null)
              setAdding(true)
            }}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus className="size-3.5" aria-hidden />
            Add a card
          </button>
        )}
      </div>

      {card.blockedBy.length === 0 && !adding && (
        <p className="text-xs text-muted-foreground/80">
          Not waiting on anything. Add a card that has to be done first.
        </p>
      )}

      {card.blockedBy.length > 0 && (
        <ul aria-label="Cards this is waiting on" className="flex flex-col gap-0.5">
          {card.blockedBy.map((ref) => (
            <LinkRow
              key={ref.cardId}
              refCard={ref}
              currentBoardId={boardId}
              busy={busy}
              onOpen={onOpenCard}
              removeLabel={`Stop waiting on "${ref.title}"`}
              onRemove={() =>
                void run({
                  type: 'card.removeBlocker',
                  id: card.id,
                  blockerId: ref.cardId
                })
              }
            />
          ))}
        </ul>
      )}

      {adding && (
        <BlockerSearch
          exclude={exclude}
          busy={busy}
          onCancel={() => setAdding(false)}
          onPick={async (hit) => {
            const ok = await run({
              type: 'card.addBlocker',
              id: card.id,
              blockerId: hit.cardId
            })
            if (ok) setAdding(false)
          }}
        />
      )}

      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}

      {card.blocking.length > 0 && (
        <>
          <h3 className="mt-1 text-sm font-medium text-muted-foreground">
            Waiting on this card
          </h3>
          <ul aria-label="Cards waiting on this" className="flex flex-col gap-0.5">
            {card.blocking.map((ref) => (
              <LinkRow
                key={ref.cardId}
                refCard={ref}
                currentBoardId={boardId}
                busy={busy}
                onOpen={onOpenCard}
                removeLabel={`Stop "${ref.title}" waiting on this card`}
                onRemove={() =>
                  void run({
                    type: 'card.removeBlocker',
                    id: ref.cardId,
                    blockerId: card.id
                  })
                }
              />
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

function LinkRow({
  refCard,
  currentBoardId,
  busy,
  onOpen,
  onRemove,
  removeLabel
}: {
  refCard: CardRef
  currentBoardId: string
  busy: boolean
  onOpen: (boardId: string, cardId: string) => void
  onRemove: () => void
  removeLabel: string
}) {
  const place =
    refCard.boardId === currentBoardId
      ? refCard.listName
      : `${refCard.boardName} · ${refCard.listName}`
  const where = refCard.number > 0 ? `${formatCardNumber(refCard.number)} · ${place}` : place
  const state = refCard.archived ? 'archived' : refCard.completed ? 'done' : 'open'
  return (
    <li className="group flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted/60">
      <span
        className={cn(
          'flex size-4 shrink-0 items-center justify-center',
          state === 'done' ? 'text-primary' : 'text-muted-foreground'
        )}
        title={state === 'done' ? 'Done' : state === 'archived' ? 'Archived' : 'Not done yet'}
      >
        {state === 'done' ? (
          <Check className="size-3.5" strokeWidth={3} aria-hidden />
        ) : state === 'archived' ? (
          <Archive className="size-3.5" aria-hidden />
        ) : (
          <Circle className="size-3" aria-hidden />
        )}
      </span>
      <div className="min-w-0 flex-1">
        {refCard.archived ? (
          // An archived card isn't on any board view, so there's nothing
          // to open; show it so the user can still see and drop the link.
          <span className="block truncate text-sm text-muted-foreground line-through">
            {refCard.title} <span className="no-underline">(archived)</span>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => onOpen(refCard.boardId, refCard.cardId)}
            className={cn(
              'block max-w-full truncate rounded text-left text-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              state === 'done' && 'text-muted-foreground line-through'
            )}
          >
            {refCard.title}
          </button>
        )}
        <span className="block truncate text-xs text-muted-foreground">{where}</span>
      </div>
      <button
        type="button"
        aria-label={removeLabel}
        title="Remove link"
        disabled={busy}
        onClick={onRemove}
        className="rounded p-1 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 group-hover:opacity-100"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </li>
  )
}

/** Inline card search for picking a card to wait on. Its own Escape
 *  closes just the search (see onKeyDown); `data-overlay` also makes the
 *  Modal and App ignore an Escape pressed elsewhere while it's open. */
function BlockerSearch({
  exclude,
  busy,
  onPick,
  onCancel
}: {
  exclude: ReadonlySet<string>
  busy: boolean
  onPick: (hit: SearchHit) => void
  onCancel: () => void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const q = useDebounced(query, 120).trim()

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const { data: hits = [] } = useQuery({
    queryKey: ['blockerSearch', q],
    queryFn: () => ipc.searchCards({ query: q, limit: 20 }),
    enabled: q.length > 0
  })
  const results = q.length > 0 ? hits.filter((h) => !exclude.has(h.cardId)).slice(0, 8) : []

  useEffect(() => setActive(0), [q])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      // Stop it here: closing unmounts this (the data-overlay the Modal
      // and App check for) before their document listeners run, so a
      // bubbling Escape would close the whole card detail too.
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, Math.max(results.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const hit = results[active]
      if (hit && !busy) onPick(hit)
    }
  }

  return (
    <div data-overlay className="flex flex-col gap-1 rounded-md border border-border bg-muted/40 p-2">
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search for the card to wait on…"
          aria-label="Search for the card to wait on"
          role="combobox"
          aria-expanded={results.length > 0}
          aria-controls={listId}
          aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
          className="min-w-0 flex-1 rounded border border-input bg-background px-2 py-1 text-sm focus:border-ring focus:outline-none"
        />
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Cancel
        </button>
      </div>
      {q.length > 0 && (
        <ul id={listId} role="listbox" aria-label="Matching cards" className="flex flex-col">
          {results.length === 0 ? (
            <li className="px-1.5 py-1 text-xs text-muted-foreground">No matching cards</li>
          ) : (
            results.map((hit, i) => (
              <li
                key={hit.cardId}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => !busy && onPick(hit)}
                className={cn(
                  'cursor-pointer rounded px-1.5 py-1',
                  i === active && 'bg-accent'
                )}
              >
                <span className="block truncate text-sm">{hit.title}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {hit.boardName} · {hit.listName}
                </span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  )
}
