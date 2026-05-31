import { describe, expect, it } from 'vitest'
import type { BoardSummary } from '@kanbini/shared'
import {
  computeBoardMoveStep,
  computeBoardMoveTarget,
  reduceBoardReorder
} from '../boards-home-dnd'

// Tests for the boards-home DnD + keyboard reorder helpers. Same
// shape as lib/board-dnd.ts: pure projections the closures in
// `boards-home.tsx` compose with. Each test uses a tiny fixture so
// the cross-pin-group guard, single-item edge cases, and the
// before/after derivation are all visible.

function makeBoard(overrides: Partial<BoardSummary> = {}): BoardSummary {
  return {
    id: 'b1',
    projectId: 'p1',
    name: 'Board',
    description: null,
    color: null,
    background: null,
    archived: false,
    pinned: false,
    position: 'a',
    listCount: 0,
    cardCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

// ─── reduceBoardReorder ───────────────────────────────────────────

describe('reduceBoardReorder', () => {
  it("returns prev unchanged when active === over", () => {
    const prev = [makeBoard({ id: 'a' }), makeBoard({ id: 'b' })]
    expect(reduceBoardReorder(prev, 'a', 'a')).toBe(prev)
  })

  it('returns prev unchanged when either side is missing', () => {
    const prev = [makeBoard({ id: 'a' })]
    expect(reduceBoardReorder(prev, 'a', 'ghost')).toBe(prev)
    expect(reduceBoardReorder(prev, 'ghost', 'a')).toBe(prev)
  })

  it("returns prev unchanged across pin-groups (pinned/unpinned can't reorder)", () => {
    const prev = [
      makeBoard({ id: 'p', pinned: true }),
      makeBoard({ id: 'u', pinned: false })
    ]
    expect(reduceBoardReorder(prev, 'p', 'u')).toBe(prev)
    expect(reduceBoardReorder(prev, 'u', 'p')).toBe(prev)
  })

  it('reorders within the unpinned group', () => {
    const prev = [
      makeBoard({ id: 'a' }),
      makeBoard({ id: 'b' }),
      makeBoard({ id: 'c' })
    ]
    const next = reduceBoardReorder(prev, 'a', 'c')
    expect(next.map((b) => b.id)).toEqual(['b', 'c', 'a'])
  })

  it('reorders within the pinned group', () => {
    const prev = [
      makeBoard({ id: 'p1', pinned: true }),
      makeBoard({ id: 'p2', pinned: true }),
      makeBoard({ id: 'u1' })
    ]
    const next = reduceBoardReorder(prev, 'p2', 'p1')
    expect(next.map((b) => b.id)).toEqual(['p2', 'p1', 'u1'])
  })
})

// ─── computeBoardMoveTarget ───────────────────────────────────────

describe('computeBoardMoveTarget', () => {
  it('returns null when the moved id is missing', () => {
    const cache = [makeBoard({ id: 'a' })]
    expect(computeBoardMoveTarget(cache, 'ghost')).toBeNull()
  })

  it('returns null for a single-item pin group (no neighbours)', () => {
    const cache = [makeBoard({ id: 'lone' })]
    expect(computeBoardMoveTarget(cache, 'lone')).toBeNull()
  })

  it("for the middle of a same-group run, returns both neighbours", () => {
    const cache = [
      makeBoard({ id: 'a' }),
      makeBoard({ id: 'b' }),
      makeBoard({ id: 'c' })
    ]
    expect(computeBoardMoveTarget(cache, 'b')).toEqual({
      beforeId: 'a',
      afterId: 'c'
    })
  })

  it("only considers same-pin-group siblings (skips cross-group neighbours)", () => {
    const cache = [
      makeBoard({ id: 'p1', pinned: true }),
      makeBoard({ id: 'p2', pinned: true }),
      makeBoard({ id: 'u1' }),
      makeBoard({ id: 'u2' })
    ]
    // p2 is in the pinned group; its only sibling is p1.
    expect(computeBoardMoveTarget(cache, 'p2')).toEqual({
      beforeId: 'p1',
      afterId: null
    })
  })

  it("for the first card in its group, beforeId is null", () => {
    const cache = [makeBoard({ id: 'a' }), makeBoard({ id: 'b' })]
    expect(computeBoardMoveTarget(cache, 'a')).toEqual({
      beforeId: null,
      afterId: 'b'
    })
  })

  it("for the last card in its group, afterId is null", () => {
    const cache = [makeBoard({ id: 'a' }), makeBoard({ id: 'b' })]
    expect(computeBoardMoveTarget(cache, 'b')).toEqual({
      beforeId: 'a',
      afterId: null
    })
  })
})

// ─── computeBoardMoveStep ─────────────────────────────────────────

describe('computeBoardMoveStep', () => {
  it("returns null when the id is missing", () => {
    expect(
      computeBoardMoveStep([makeBoard({ id: 'a' })], 'ghost', 'up')
    ).toBeNull()
  })

  it("returns null at the top of the group for 'up'", () => {
    const visible = [
      makeBoard({ id: 'a' }),
      makeBoard({ id: 'b' })
    ]
    expect(computeBoardMoveStep(visible, 'a', 'up')).toBeNull()
  })

  it("returns null at the bottom of the group for 'down'", () => {
    const visible = [
      makeBoard({ id: 'a' }),
      makeBoard({ id: 'b' })
    ]
    expect(computeBoardMoveStep(visible, 'b', 'down')).toBeNull()
  })

  it("'up' from the middle swaps with the previous sibling", () => {
    const visible = [
      makeBoard({ id: 'a' }),
      makeBoard({ id: 'b' }),
      makeBoard({ id: 'c' })
    ]
    // Moving b up: lands above a → beforeId null (top), afterId 'a'.
    expect(computeBoardMoveStep(visible, 'b', 'up')).toEqual({
      beforeId: null,
      afterId: 'a'
    })
  })

  it("'up' from the end lands before the previous neighbour", () => {
    const visible = [
      makeBoard({ id: 'a' }),
      makeBoard({ id: 'b' }),
      makeBoard({ id: 'c' })
    ]
    expect(computeBoardMoveStep(visible, 'c', 'up')).toEqual({
      beforeId: 'a',
      afterId: 'b'
    })
  })

  it("'down' from the start lands between the next two", () => {
    const visible = [
      makeBoard({ id: 'a' }),
      makeBoard({ id: 'b' }),
      makeBoard({ id: 'c' })
    ]
    expect(computeBoardMoveStep(visible, 'a', 'down')).toEqual({
      beforeId: 'b',
      afterId: 'c'
    })
  })

  it("'down' from the middle lands at the bottom (afterId null)", () => {
    const visible = [
      makeBoard({ id: 'a' }),
      makeBoard({ id: 'b' }),
      makeBoard({ id: 'c' })
    ]
    expect(computeBoardMoveStep(visible, 'b', 'down')).toEqual({
      beforeId: 'c',
      afterId: null
    })
  })

  it("only considers same-pin-group siblings (pinned can't move past unpinned)", () => {
    const visible = [
      makeBoard({ id: 'p1', pinned: true }),
      makeBoard({ id: 'p2', pinned: true }),
      makeBoard({ id: 'u1' }),
      makeBoard({ id: 'u2' })
    ]
    // p2 has no down step in its group (it's the last pinned).
    expect(computeBoardMoveStep(visible, 'p2', 'down')).toBeNull()
    // u1 has no up step in its group (it's the first unpinned).
    expect(computeBoardMoveStep(visible, 'u1', 'up')).toBeNull()
  })
})
