import { describe, expect, it } from 'vitest'
import {
  cardNumberNeedsBoardMessage,
  fillMissingCardNumbers,
  formatCardNumber,
  hasPerBoardCardNumbers,
  parseCardNumberRef
} from '../card-number'

describe('parseCardNumberRef', () => {
  it('reads #N and bare N, ignoring surrounding space', () => {
    expect(parseCardNumberRef('#142')).toBe(142)
    expect(parseCardNumberRef('142')).toBe(142)
    expect(parseCardNumberRef('  #7 ')).toBe(7)
  })

  it('rejects anything that is not a positive whole number', () => {
    for (const s of ['', '#', '#0', '0', '-3', '#1.5', '12a', '# 12', '##12', 'abc']) {
      expect(parseCardNumberRef(s)).toBeNull()
    }
    // A UUIDv7 card id is never mistaken for a number.
    expect(parseCardNumberRef('0190f1e2-7a3b-7c4d-8e5f-6a7b8c9d0e1f')).toBeNull()
    // Too long to be a real number (and past safe-integer range).
    expect(parseCardNumberRef('#12345678901234567890')).toBeNull()
  })
})

describe('formatCardNumber', () => {
  it('prefixes a hash', () => {
    expect(formatCardNumber(142)).toBe('#142')
  })
})

describe('fillMissingCardNumbers', () => {
  const lists = [
    { id: 'la', boardId: 'A' },
    { id: 'lb', boardId: 'B' }
  ]

  it('numbers each board from 1 in creation order, id breaking ties', () => {
    const got = fillMissingCardNumbers({
      boards: [
        { id: 'A', cardNumberLast: 0 },
        { id: 'B', cardNumberLast: 0 }
      ],
      lists,
      cards: [
        { id: 'b', listId: 'la', createdAt: 200 },
        { id: 'c', listId: 'la', createdAt: 100 },
        { id: 'a', listId: 'la', createdAt: 200 },
        { id: 'd', listId: 'lb', createdAt: 150 }
      ]
    })
    expect(Object.fromEntries(got)).toEqual({ c: 1, a: 2, b: 3, d: 1 })
  })

  it("keeps existing numbers and starts after the board's highest and its counter", () => {
    const got = fillMissingCardNumbers({
      boards: [
        { id: 'A', cardNumberLast: 9 },
        { id: 'B', cardNumberLast: 0 }
      ],
      lists,
      cards: [
        { id: 'x', listId: 'la', createdAt: 1, number: 4 },
        { id: 'y', listId: 'la', createdAt: 2, number: null },
        { id: 'z', listId: 'la', createdAt: 3 },
        { id: 'w', listId: 'lb', createdAt: 4, number: 6 },
        { id: 'v', listId: 'lb', createdAt: 5 }
      ]
    })
    expect(Object.fromEntries(got)).toEqual({ x: 4, y: 10, z: 11, w: 6, v: 7 })
  })

  it('renumbers an export written before per-board counters, ignoring its numbers', () => {
    const got = fillMissingCardNumbers({
      boards: [{ id: 'A' }, { id: 'B' }],
      lists,
      cards: [
        { id: 'x', listId: 'la', createdAt: 1, number: 1 },
        { id: 'y', listId: 'lb', createdAt: 2, number: 2 },
        { id: 'z', listId: 'la', createdAt: 3, number: 3 }
      ]
    })
    expect(Object.fromEntries(got)).toEqual({ x: 1, y: 1, z: 2 })
  })
})

describe('hasPerBoardCardNumbers', () => {
  it('needs a counter on every board', () => {
    expect(hasPerBoardCardNumbers([{ cardNumberLast: 0 }, { cardNumberLast: 3 }])).toBe(true)
    expect(hasPerBoardCardNumbers([{ cardNumberLast: 3 }, {}])).toBe(false)
    expect(hasPerBoardCardNumbers([])).toBe(true)
  })
})

describe('cardNumberNeedsBoardMessage', () => {
  it('names the boards that have the number, or says none does', () => {
    expect(
      cardNumberNeedsBoardMessage(12, [
        { id: 'b1', name: 'Home' },
        { id: 'b2', name: 'Work' }
      ])
    ).toBe(
      'Card numbers are per board: pass boardId to look up #12. Boards with a card #12: "Home" (b1), "Work" (b2).'
    )
    expect(cardNumberNeedsBoardMessage(9, [])).toBe(
      'Card numbers are per board: pass boardId to look up #9. No board has a card #9.'
    )
  })
})
