import { useEffect, useState } from 'react'
import { Lock, LockOpen } from 'lucide-react'
import { onWriteBlocked, useBoardReadOnly } from '../lib/read-only'
import { cn } from '../lib/utils'
import { Tooltip } from './ui/tooltip'

// The read-only lock's two pieces of chrome (lib/read-only.ts): the
// header toggle and the pill that says the board is locked. The pill
// shakes when a refusal on its board is signalled, so a click that did
// nothing says why.

const LOCK_HINT = 'While it’s locked you can only tick checklist items and mark cards complete. The AI can still edit it.'

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
