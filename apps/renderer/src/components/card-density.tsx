import { ChevronsDownUp, ChevronsUpDown, ListChecks, MessageSquare, Paperclip } from 'lucide-react'
import type { CardView } from '@kanbini/shared'
import { checklistProgress } from '../lib/card-density'
import { cn } from '../lib/utils'

// UI pieces for collapsible cards. A compact card drops its cover, URL
// chip, and checklist items; these badges keep a one-line summary of
// what it's hiding so a collapsed card still says "there's more here".
// Styled to sit in the same meta row as DescriptionBadge / PriorityBadge
// / DueBadge.

function CountBadge({
  icon,
  text,
  title
}: {
  icon: React.ReactNode
  text: string
  title: string
}) {
  return (
    <span
      className="flex items-center gap-0.5 text-xs text-muted-foreground"
      title={title}
    >
      {icon}
      {text}
    </span>
  )
}

/** Checklist progress, comment count, and attachment count - each only
 *  when non-zero, so a bare card's compact row stays empty. */
export function CompactBadges({ card }: { card: CardView }) {
  const progress = checklistProgress(card)
  const comments = card.comments.length
  const attachments = card.attachments.length
  return (
    <>
      {progress && (
        <CountBadge
          icon={<ListChecks className="size-3.5" />}
          text={`${progress.done}/${progress.total}`}
          title={`${progress.done} of ${progress.total} checklist items done`}
        />
      )}
      {comments > 0 && (
        <CountBadge
          icon={<MessageSquare className="size-3.5" />}
          text={String(comments)}
          title={comments === 1 ? '1 comment' : `${comments} comments`}
        />
      )}
      {attachments > 0 && (
        <CountBadge
          icon={<Paperclip className="size-3.5" />}
          text={String(attachments)}
          title={attachments === 1 ? '1 attachment' : `${attachments} attachments`}
        />
      )}
    </>
  )
}

/** Hover button that collapses / expands one card. Same hit target and
 *  hover reveal as the card's pencil, which it sits beside. */
export function CollapseToggle({
  compact,
  onToggle,
  className
}: {
  compact: boolean
  onToggle: () => void
  className?: string
}) {
  const label = compact ? 'Expand card' : 'Collapse card'
  const Icon = compact ? ChevronsUpDown : ChevronsDownUp
  return (
    <button
      aria-label={label}
      title={label}
      // Never start a card drag from the button.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        onToggle()
        // Chrome focuses a clicked button; drop it so the card's
        // focus-within styles don't stick (same as the complete box).
        ;(e.currentTarget as HTMLButtonElement).blur()
      }}
      className={cn(
        'rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground',
        className
      )}
    >
      <Icon className="size-3.5" />
    </button>
  )
}
