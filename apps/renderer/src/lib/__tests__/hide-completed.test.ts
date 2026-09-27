import { describe, expect, it } from 'vitest'
import type { BoardView, CardView, ListView } from '@kanbini/shared'
import {
  countCompleted,
  filterCompleted,
  loadHideCompleted,
  saveHideCompleted
} from '../hide-completed'

const card = (id: string, completed: boolean): CardView =>
  ({ id, completed } as unknown as CardView)
const list = (id: string, cards: CardView[], closed = false): ListView =>
  ({ id, closed, cards } as unknown as ListView)
const board = (lists: ListView[]): BoardView => ({ lists } as unknown as BoardView)

describe('filterCompleted', () => {
  const b = board([
    list('l1', [card('a', false), card('b', true)]),
    list('l2', [card('c', true)])
  ])

  it('passes the same board through when off', () => {
    expect(filterCompleted(b, false)).toBe(b)
  })

  it('drops completed cards when on', () => {
    const out = filterCompleted(b, true)
    expect(out.lists.map((l) => l.cards.map((c) => c.id))).toEqual([['a'], []])
  })
})

describe('countCompleted', () => {
  it('counts completed cards in open lists only', () => {
    const b = board([
      list('l1', [card('a', true), card('b', false)]),
      list('closed', [card('c', true)], true)
    ])
    expect(countCompleted(b)).toBe(1)
  })
})

describe('per-board persistence', () => {
  it('remembers each board separately', () => {
    expect(loadHideCompleted('b1')).toBe(false)
    saveHideCompleted('b1', true)
    expect(loadHideCompleted('b1')).toBe(true)
    expect(loadHideCompleted('b2')).toBe(false)
    saveHideCompleted('b1', false)
    expect(loadHideCompleted('b1')).toBe(false)
    expect(localStorage.getItem('kanbini.hideCompleted')).toBe('{}')
  })

  it('shrugs off a corrupt value', () => {
    localStorage.setItem('kanbini.hideCompleted', 'not json')
    expect(loadHideCompleted('b1')).toBe(false)
  })
})
