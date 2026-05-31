// Shared drag/drop polish constants - the small set of numbers that
// govern how "buttery" the kanban drop feels. Extracted from
// `components/board.tsx` so the invariant tests in
// `__tests__/drag-polish.test.ts` can drift-detect changes to either
// value, and so any future surface that wires up dnd-kit's
// `DragOverlay` (boards-home grid, a future swimlane variant, etc.)
// can stay in lockstep.
//
// All values were arrived at by iterating with the user in front of
// the running app - see ADR-0048 for the full chain of fixes that
// landed here.

/** How long dnd-kit's `DropAnimation` glides the overlay from release
 *  point to landing slot, in ms. The first value the user notices
 *  after letting go - too long and the drop feels sluggish, too
 *  short and there's no time for the shadow to settle. 200 ms is the
 *  fastest value that still reads as "smooth glide" rather than
 *  "instant snap" against the cubic-bezier(0.22, 1, 0.36, 1) ease. */
export const DROP_ANIMATION_DURATION_MS = 200 as const

/** How long the just-dropped `SortableCard` force-paints itself in
 *  the source's `:hover` styles after `isDragging` flips false. Must
 *  outlast `DROP_ANIMATION_DURATION_MS` so the source is still at
 *  the hovered values when the overlay unmounts (otherwise the
 *  :hover-engagement on the visible source fires a 150 ms
 *  transition - the "snap" of the shadow appearing again at handoff).
 *  Tail buffer covers any animation-frame jitter between WAAPI's end
 *  callback and React's next render. */
export const POST_DROP_HOLD_MS = 220 as const
