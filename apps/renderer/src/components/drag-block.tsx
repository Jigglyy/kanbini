import type { ReactNode } from 'react'

/** Most card faces a multi-card drag overlay shows, grabbed card included. */
export const MULTI_DRAG_MAX_FACES = 4

/** Drag-overlay content for a multi-selection drag: the grabbed card
 *  (children) with a count badge, and the other selected cards listed
 *  under it as one block, capped with a "+N more" line. With no
 *  followers it renders the grabbed card alone, unchanged. */
export function MultiDragBlock({
  followers,
  children
}: {
  /** The other selected cards, in pre-drag board order. */
  followers: { id: string; face: ReactNode }[]
  children: ReactNode
}) {
  if (followers.length === 0) return <>{children}</>
  const shown = followers.slice(0, MULTI_DRAG_MAX_FACES - 1)
  const hidden = followers.length - shown.length
  return (
    <>
      {children}
      <span
        data-drag-count
        className="absolute -right-2 -top-2 z-10 flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-xs font-semibold text-primary-foreground shadow"
      >
        {followers.length + 1}
      </span>
      {/* Hangs below the overlay's box (dnd-kit sizes it to the grabbed
          card), so collision, the drop target and the hover area stay
          the grabbed card's alone; pointer-events-none keeps it off the
          hover hit test. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-full mt-1 flex flex-col gap-1"
      >
        {shown.map((f) => (
          <div key={f.id} data-drag-follower className="rounded-md shadow-md">
            {f.face}
          </div>
        ))}
        {hidden > 0 && (
          <div className="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-md">
            +{hidden} more
          </div>
        )}
      </div>
    </>
  )
}
