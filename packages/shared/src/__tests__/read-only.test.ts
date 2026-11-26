import { describe, expect, it } from 'vitest'
import { isTick, isViewChange, passesReadOnlyLock } from '../read-only'

// What the read-only board lock lets through (ADR-0089): ticks and view
// settings, alone in their patch.

describe('passesReadOnlyLock', () => {
  it('lets a tick through, on a card or a checklist item', () => {
    expect(isTick({ type: 'card.update', id: 'c', patch: { completed: true } })).toBe(true)
    expect(
      isTick({ type: 'checklistItem.update', id: 'i', patch: { completed: false } })
    ).toBe(true)
  })

  it('lets view settings through', () => {
    for (const m of [
      { type: 'card.update', id: 'c', patch: { collapsed: null } },
      { type: 'list.update', id: 'l', patch: { cardDensity: 'compact', visibleCardLimit: 10 } },
      { type: 'board.update', id: 'b', patch: { swimlaneMode: 'priority' } },
      { type: 'board.update', id: 'b', patch: { pinned: true } }
    ] as const) {
      expect(isViewChange(m)).toBe(true)
      expect(passesReadOnlyLock(m)).toBe(true)
    }
  })

  it('refuses anything that changes content, even next to a tick or view setting', () => {
    for (const m of [
      { type: 'card.update', id: 'c', patch: { completed: true, title: 'x' } },
      { type: 'card.update', id: 'c', patch: { collapsed: true, priority: 'high' } },
      { type: 'list.update', id: 'l', patch: { visibleCardLimit: 5, name: 'x' } },
      { type: 'list.update', id: 'l', patch: { sortMode: 'title-asc' } },
      { type: 'board.update', id: 'b', patch: { name: 'x' } },
      { type: 'card.update', id: 'c', patch: {} },
      { type: 'card.delete', id: 'c' }
    ] as const) {
      expect(passesReadOnlyLock(m)).toBe(false)
    }
  })
})
