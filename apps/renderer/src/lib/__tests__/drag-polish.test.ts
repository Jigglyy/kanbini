import { describe, expect, it } from 'vitest'
import {
  DROP_ANIMATION_DURATION_MS,
  POST_DROP_HOLD_MS
} from '../drag-polish'

// Drift-detection for the two timing constants that govern how
// "buttery" the kanban drop feels. The invariants below are the
// contracts the choreography depends on - if someone tunes one
// number without re-checking the other, the source's `:hover`
// transition fires at handoff and the user sees the
// "shadow / border appears again" snap that took several rounds of
// front-end iteration to chase down (ADR-0048). These tests pin the
// values so a future "let's bump the drop a bit" PR has to confront
// the relationship explicitly.

describe('drag-polish constants', () => {
  it('DROP_ANIMATION_DURATION_MS is short enough to feel responsive but long enough to read as smooth', () => {
    // < 150 ms tends to feel like a hard snap (insufficient time for
    // ease-out to convey deceleration). > 320 ms starts to feel
    // sluggish - the user reported it explicitly at 360 ms.
    expect(DROP_ANIMATION_DURATION_MS).toBeGreaterThanOrEqual(150)
    expect(DROP_ANIMATION_DURATION_MS).toBeLessThanOrEqual(320)
  })

  it('POST_DROP_HOLD_MS outlasts the drop animation', () => {
    // The hold's job is to keep the source SortableCard painted in
    // its hovered styles until AFTER the overlay unmounts. If the
    // hold expires first, the source's class flips, the source's
    // :hover engagement fires a 150 ms transition, and the user sees
    // the "shadow appears again" snap at handoff. So hold > drop is
    // load-bearing.
    expect(POST_DROP_HOLD_MS).toBeGreaterThan(DROP_ANIMATION_DURATION_MS)
  })

  it('POST_DROP_HOLD_MS buffer past the drop is small (no perceptible "stuck" feel)', () => {
    // Buffer covers animation-frame jitter between WAAPI's end
    // callback and React's next render - empirically ~16 ms is
    // enough; we use 20 ms. More than ~60 ms and the user starts
    // to perceive the card as "stuck" in its hovered styles after
    // the drop has visibly settled.
    const buffer = POST_DROP_HOLD_MS - DROP_ANIMATION_DURATION_MS
    expect(buffer).toBeGreaterThan(0)
    expect(buffer).toBeLessThanOrEqual(60)
  })
})
