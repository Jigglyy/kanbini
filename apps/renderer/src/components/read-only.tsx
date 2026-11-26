import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Lock, LockOpen, X } from 'lucide-react'
import { onWriteBlocked, useBoardReadOnly } from '../lib/read-only'
import { cn } from '../lib/utils'
import { Tooltip } from './ui/tooltip'

// The read-only lock's two pieces of chrome (lib/read-only.ts): the
// header toggle and the pill that says the board is locked. The pill
// shakes when a refusal on its board is signalled, so a click that did
// nothing says why.

const LOCK_HINT =
  'While it’s locked you can still tick checklist items, mark cards complete and change how the board is shown. The AI can still edit it.'

export function ReadOnlyToggle({ boardId }: { boardId: string }) {
  const [locked, setLocked] = useBoardReadOnly(boardId)
  const label = locked ? 'Unlock board' : 'Lock board (read-only)'
  return (
    <Tooltip label={locked ? `Unlock board. ${LOCK_HINT}` : `Lock board. ${LOCK_HINT}`} side="bottom">
      <button
        type="button"
        onClick={() => setLocked(!locked)}
        aria-pressed={locked}
        aria-label={label}
        className={`inline-flex size-8 items-center justify-center rounded-md hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
          locked ? 'bg-accent text-foreground' : 'text-muted-foreground'
        }`}
      >
        {locked ? (
          <Lock className="size-4" aria-hidden />
        ) : (
          <LockOpen className="size-4" aria-hidden />
        )}
      </button>
    </Tooltip>
  )
}

/** How long the "can't undo" note stays up on its own. */
const LOCKED_UNDO_NOTICE_MS = 6000

/** Floating note when Ctrl+Z / Ctrl+Y was refused because it would change
 *  a locked board (a card moved or linked there from another board, or an
 *  AI run spanning both). Same floating-pill look as HiddenCardNotice;
 *  body-portaled so the board's zoom doesn't scale it. Goes away on its
 *  own after a few seconds. */
export function LockedUndoNotice({
  boardName,
  redo,
  onOpen,
  onDismiss
}: {
  boardName: string
  redo: boolean
  /** Go to the locked board (to unlock it). Omitted when it's on screen. */
  onOpen?: () => void
  onDismiss: () => void
}) {
  // The parent passes a fresh onDismiss each render; a ref keeps the
  // timer from restarting on every App render.
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss
  useEffect(() => {
    const t = window.setTimeout(() => dismissRef.current(), LOCKED_UNDO_NOTICE_MS)
    return () => window.clearTimeout(t)
  }, [boardName, redo])
  return createPortal(
    <div
      role="status"
      className="fixed bottom-6 left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-xl border border-border bg-card/95 py-1.5 pl-3 pr-1.5 text-sm text-foreground shadow-lg backdrop-blur"
    >
      <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 wrap-anywhere">
        Can’t {redo ? 'redo' : 'undo'}: it would change “{boardName}”, which is locked.
        Unlock it first.
      </span>
      {onOpen && (
        <button
          type="button"
          onClick={onOpen}
          className="inline-flex shrink-0 items-center rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          Go to board
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>,
    document.body
  )
}

/** "Read-only" beside the board name and in the card detail header.
 *  Renders nothing while the board is unlocked. */
export function ReadOnlyPill({ boardId }: { boardId: string }) {
  const [locked] = useBoardReadOnly(boardId)
  // Alternating classes restart the CSS animation on each signal (the
  // same trick as the list's card-limit shake).
  const [tick, setTick] = useState(0)
  useEffect(
    () =>
      onWriteBlocked((id) => {
        if (id === boardId) setTick((t) => t + 1)
      }),
    [boardId]
  )
  if (!locked) return null
  return (
    <span
      title={LOCK_HINT}
      data-testid="read-only-pill"
      className={cn(
        'inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground',
        tick > 0 && (tick % 2 === 1 ? 'shake-a' : 'shake-b')
      )}
    >
      <Lock className="size-3" aria-hidden />
      Read-only
    </span>
  )
}
