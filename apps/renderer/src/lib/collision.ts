import {
  closestCorners,
  type ClientRect,
  type CollisionDetection,
  type DroppableContainer,
  type UniqueIdentifier
} from '@dnd-kit/core'

// Card-drag collision detection that stays cheap on big boards.
//
// dnd-kit's closestCorners scores EVERY droppable on every pointer move,
// and every rect it reads is a dnd-kit `Rect` whose top/left getters
// re-read the scroll position of each scrollable ancestor. On a board
// with a few hundred cards that was most of a drag's collision cost. Only
// cards close to the dragged one can win, so this hands closestCorners
// just those: for each sortable list (a SortableContext, grouped by its
// containerId) that is horizontally near the dragged card, a window of
// cards around the one whose top is nearest the dragged card's top
// (found by binary search, since a list's cards stack top to bottom in
// index order). Droppables that aren't sortable items (the list drop
// zones) always stay in, and a second pass adds any list that could
// still beat the best hit. The result is the same top hit as the full
// search; `collision.test.ts` pins that against closestCorners itself.

/** Cards kept either side of the nearest one. A stacked list's corner
 *  distance grows steadily away from the nearest card, so a few are
 *  plenty; extra ones only cost a little. */
const WINDOW = 6

interface SortableData {
  containerId: UniqueIdentifier
  index: number
}

const sortableOf = (c: DroppableContainer): SortableData | undefined =>
  (c.data.current as { sortable?: SortableData } | undefined)?.sortable

/** Horizontal gap between two spans (0 when they overlap). */
const gapX = (a: ClientRect, left: number, right: number): number =>
  Math.max(0, a.left - right, left - (a.left + a.width))

export const closestCornersNearby: CollisionDetection = (args) => {
  const { collisionRect, droppableRects, droppableContainers } = args
  const candidates: DroppableContainer[] = []
  const groups = new Map<UniqueIdentifier, { c: DroppableContainer; index: number }[]>()
  for (const c of droppableContainers) {
    const sortable = sortableOf(c)
    if (!sortable) {
      candidates.push(c)
      continue
    }
    if (!droppableRects.get(c.id)) continue
    const group = groups.get(sortable.containerId)
    if (group) group.push({ c, index: sortable.index })
    else groups.set(sortable.containerId, [{ c, index: sortable.index }])
  }

  const left = collisionRect.left
  const right = collisionRect.left + collisionRect.width
  const lists = [...groups.values()].map((group) => ({
    group,
    gap: gapX(droppableRects.get(group[0]!.c.id)!, left, right),
    added: false
  }))
  const add = (list: (typeof lists)[number]): void => {
    list.added = true
    const { group } = list
    group.sort((a, b) => a.index - b.index)
    // First card whose top is at or below the dragged card's top.
    let lo = 0
    let hi = group.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (droppableRects.get(group[mid]!.c.id)!.top < collisionRect.top) lo = mid + 1
      else hi = mid
    }
    const to = Math.min(group.length, lo + WINDOW)
    for (let i = Math.max(0, lo - WINDOW); i < to; i++) candidates.push(group[i]!.c)
  }

  // First pass: lists within a card's width of the dragged card (so the
  // neighbour across the gap competes), or the nearest one.
  const inReach = lists.filter((l) => l.gap <= collisionRect.width)
  if (inReach.length > 0) inReach.forEach(add)
  else if (lists.length > 0) add(lists.reduce((a, b) => (b.gap < a.gap ? b : a)))
  let hits = closestCorners({ ...args, droppableContainers: candidates })

  // A card's corner distance is at least its list's horizontal gap, so a
  // list further away than the best hit can't win. Bring in any that's
  // closer (a short list's empty space can sit nearer a long list's card
  // a few columns over) and score again.
  const best = (hits[0]?.data?.value as number | undefined) ?? Infinity
  const more = lists.filter((l) => !l.added && l.gap < best)
  if (more.length > 0) {
    more.forEach(add)
    hits = closestCorners({ ...args, droppableContainers: candidates })
  }
  return hits
}
