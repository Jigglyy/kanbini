import { createPortal } from 'react-dom'
import { Eye, X } from 'lucide-react'
import type { HiddenCardReason } from '../lib/hidden-card'

// Floating note for "show on board" when a filter hides the card (see
// lib/hidden-card.ts). Says which filter, offers to clear it; never
// clears anything on its own. Same floating-pill look as SelectionBar,
// body-portaled so the board's zoom doesn't scale it.

export function HiddenCardNotice({
  reason,
  onShow,
  onDismiss
}: {
  reason: HiddenCardReason
  onShow: () => void
  onDismiss: () => void
}) {
  const by =
    reason.byLabels && reason.byCompleted
      ? 'your label filter and Hide completed'
      : reason.byLabels
        ? 'your label filter'
        : 'Hide completed'
  return createPortal(
    <div
      role="status"
      className="fixed bottom-6 left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-xl border border-border bg-card/95 py-1.5 pl-3 pr-1.5 text-sm text-foreground shadow-lg backdrop-blur"
    >
      <span className="min-w-0 wrap-anywhere">
        “{reason.title}” is hidden by {by}.
      </span>
      <button
        type="button"
        onClick={onShow}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
      >
        <Eye className="size-3.5" aria-hidden /> Show it
      </button>
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
