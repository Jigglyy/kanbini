import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

// Generic modal: body portal, Escape + backdrop click to close, locks
// body scroll while open. ARIA-roled; doesn't focus-trap (overkill
// for an offline single-user desktop kanban).

// Module-level stack of open Modal close handlers. Each mount pushes
// its onClose; each unmount pops. The top of the stack is the
// currently-topmost open modal - only that one responds to Escape.
//
// Without this, two stacked modals (e.g. the CardDetail modal with
// the URL cover picker on top of it) would BOTH fire their onClose
// on a single Escape press because each registers its own
// `document.keydown` listener - the user would press Esc expecting
// to close just the URL picker and the card detail would close too.
const escapeStack: Array<() => void> = []

export function Modal({
  open,
  onClose,
  label,
  children
}: {
  open: boolean
  onClose: () => void
  label?: string
  children: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    escapeStack.push(onClose)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // A popover / context menu (data-overlay) rendered on TOP of this
      // modal - e.g. the Markdown editor's Link popover inside the card
      // detail - owns the first Escape; let it close itself before the
      // modal reacts (matches App.tsx's back-stack). Modals + the
      // lightbox use role="dialog" (not data-overlay), so modal-on-modal
      // stacking + the lightbox's own capture handler are unaffected.
      if (document.querySelector('[data-overlay]')) return
      // Each open Modal's effect installs its own document listener,
      // so every modal's handler fires for every Escape. Only act if
      // THIS modal is the topmost - anyone underneath stays put.
      if (escapeStack[escapeStack.length - 1] === onClose) onClose()
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      const i = escapeStack.lastIndexOf(onClose)
      if (i !== -1) escapeStack.splice(i, 1)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  if (!open) return null
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={onClose}
      // `overflow-anchor: none` - when a child's height changes (e.g. the
      // description swapping to its taller edit mode), the browser's
      // scroll-anchoring would otherwise re-adjust scrollTop and let the
      // position drift on repeated open/close (ADR-0058). MarkdownField
      // also pins scrollTop across the swap; this stops the browser from
      // fighting that restore.
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto [overflow-anchor:none] bg-black/60 px-4 py-10 backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl rounded-lg border border-border bg-card text-foreground shadow-2xl"
      >
        {children}
      </div>
    </div>,
    document.body
  )
}
