import { describe, expect, it } from 'vitest'
import {
  closestCorners,
  type ClientRect,
  type CollisionDescriptor,
  type DroppableContainer
} from '@dnd-kit/core'
import { closestCornersNearby } from '../collision'

// closestCornersNearby must pick the SAME target as dnd-kit's
// closestCorners over every droppable, while reading only a handful of
// rects (each rect read is a scroll-aware getter in dnd-kit).

const COL_W = 272
const COL_GAP = 12

/** Small seeded PRNG so a failure reproduces. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

interface Board {
  containers: DroppableContainer[]
  rects: Map<string, ClientRect>
}

const rect = (left: number, top: number, width: number, height: number): ClientRect => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height
})

/** Columns of stacked cards of random height, plus one list drop zone
 *  per column (a droppable with no sortable data). */
function makeBoard(cardsPerColumn: number[], seed = 1): Board {
  const rand = rng(seed)
  const containers: DroppableContainer[] = []
  const rects = new Map<string, ClientRect>()
  cardsPerColumn.forEach((n, col) => {
    const x = 16 + col * (COL_W + COL_GAP)
    let y = 120
    for (let i = 0; i < n; i++) {
      const id = `c${col}-${i}`
      const h = 36 + Math.floor(rand() * 90)
      rects.set(id, rect(x + 8, y, COL_W - 16, h))
      containers.push({
        id,
        key: id,
        data: { current: { sortable: { containerId: `list-${col}`, index: i } } }
      } as unknown as DroppableContainer)
      y += h + 8
    }
    const listId = `list:${col}`
    rects.set(listId, rect(x, 80, COL_W, Math.max(120, y - 80 + 40)))
    containers.push({ id: listId, key: listId, data: { current: {} } } as unknown as DroppableContainer)
  })
  return { containers, rects }
}

function run(
  detect: typeof closestCorners,
  board: Board,
  collisionRect: ClientRect,
  rects: Map<string, ClientRect> = board.rects
): CollisionDescriptor[] {
  return detect({
    active: { id: 'dragged', data: { current: {} }, rect: { current: { initial: null, translated: null } } },
    collisionRect,
    droppableRects: rects,
    droppableContainers: board.containers,
    pointerCoordinates: null
  } as unknown as Parameters<typeof closestCorners>[0]) as CollisionDescriptor[]
}

describe('closestCornersNearby', () => {
  it('picks the same target as closestCorners across the whole board', () => {
    const board = makeBoard([9, 5, 10, 203, 0, 2], 7)
    const rand = rng(42)
    for (let i = 0; i < 2000; i++) {
      const w = COL_W - 16
      const h = 36 + Math.floor(rand() * 90)
      const left = -100 + rand() * (6 * (COL_W + COL_GAP) + 200)
      const top = -200 + rand() * 9000
      const dragged = rect(left, top, w, h)
      const full = run(closestCorners, board, dragged)
      const near = run(closestCornersNearby, board, dragged)
      expect(near[0]?.id, `case ${i}`).toBe(full[0]?.id)
    }
  })

  it('reads only a few rects on a long list', () => {
    const board = makeBoard([9, 203, 9], 3)
    let reads = 0
    const counted = new Map<string, ClientRect>()
    for (const [id, r] of board.rects) {
      counted.set(
        id,
        new Proxy(r, {
          get(target, key) {
            if (key === 'top' || key === 'left') reads++
            return target[key as keyof ClientRect]
          }
        })
      )
    }
    const dragged = rect(16 + COL_W + COL_GAP + 8, 3000, COL_W - 16, 60)
    run(closestCornersNearby, board, dragged, counted)
    const nearby = reads
    reads = 0
    run(closestCorners, board, dragged, counted)
    expect(reads).toBeGreaterThan(400)
    expect(nearby).toBeLessThan(80)
  })

  it('still finds a list drop zone when no list has cards', () => {
    const board = makeBoard([0, 0, 0])
    const dragged = rect(16 + COL_W + COL_GAP + 8, 130, COL_W - 16, 60)
    expect(run(closestCornersNearby, board, dragged)[0]?.id).toBe('list:1')
  })

  it('falls back to the nearest list when the card is far from every list', () => {
    const board = makeBoard([4, 4])
    const dragged = rect(3000, 140, COL_W - 16, 60)
    const full = run(closestCorners, board, dragged)
    expect(run(closestCornersNearby, board, dragged)[0]?.id).toBe(full[0]?.id)
  })
})
