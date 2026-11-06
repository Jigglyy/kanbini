import { describe, expect, it, vi } from 'vitest'
import type { BoardView, BoardsListView, CardView } from '@kanbini/shared'
import { Resolver, findBoard, findLabel, findList, type ResolverIO } from '../refs'

// Turning names, #numbers and batch $refs into ids.

const ID = (n: number) => `0190${String(n).padStart(4, '0')}-0000-7000-8000-000000000000`

const view = {
  project: { id: 'p', name: 'P' },
  board: { id: ID(1), name: 'Dice Inc', color: null, background: null, swimlaneMode: null },
  labels: [
    { id: ID(20), name: 'Bug', color: 'red' },
    { id: ID(21), name: 'UI', color: 'blue' }
  ],
  lists: [
    { id: ID(10), name: 'To Do', closed: false, cards: [{ id: ID(100), number: 12 }] },
    { id: ID(11), name: 'Done', closed: true, cards: [] },
    { id: ID(12), name: 'Done', closed: false, cards: [] },
    { id: ID(13), name: 'Twin', closed: false, cards: [] },
    { id: ID(14), name: 'twin', closed: false, cards: [] }
  ]
} as unknown as BoardView

const boards = [
  { id: ID(1), name: 'Dice Inc', archived: false },
  { id: ID(2), name: 'Old', archived: true }
] as unknown as BoardsListView

describe('finders', () => {
  it('match names in any case and spacing, preferring open lists', () => {
    expect(findList(view, '  to   do ').id).toBe(ID(10))
    expect(findList(view, 'DONE').id).toBe(ID(12))
    expect(findLabel(view, 'bug')).toBe(ID(20))
    expect(findBoard(boards, 'dice inc')).toBe(ID(1))
  })

  it('say which names exist when nothing matches, and refuse a tie', () => {
    expect(() => findList(view, 'Doing')).toThrow(/No list named "Doing" on "Dice Inc"\. Lists there: "To Do", "Done", "Twin", "twin"/)
    expect(() => findList(view, 'twin')).toThrow(/2 lists are named "twin"/)
    expect(() => findLabel(view, 'Perf')).toThrow(/Labels there: "Bug", "UI"/)
  })

  it('pass ids through', () => {
    expect(findBoard(boards, ID(9))).toBe(ID(9))
    expect(findLabel(view, ID(99))).toBe(ID(99))
  })
})

function io(over: Partial<ResolverIO> = {}): ResolverIO {
  return {
    listBoards: vi.fn(async () => boards),
    boardView: vi.fn(async () => view),
    card: vi.fn(async () => null),
    ...over
  }
}

describe('Resolver', () => {
  it('finds a card by number on a named board, from one board read', async () => {
    const deps = io()
    const r = new Resolver(deps)
    expect(await r.card('#12', 'Dice Inc')).toBe(ID(100))
    expect(await r.card('12', ID(1))).toBe(ID(100))
    expect(deps.boardView).toHaveBeenCalledTimes(1)
  })

  it('falls back to card.get for a number not on the board view (archived)', async () => {
    const card = vi.fn(async () => ({ id: ID(101) }) as CardView)
    const r = new Resolver(io({ card }))
    expect(await r.card('#40', ID(1))).toBe(ID(101))
    expect(card).toHaveBeenCalledWith('#40', ID(1))
  })

  it('needs a board for numbers and names, unless the batch gives one', async () => {
    await expect(new Resolver(io()).card('#12')).rejects.toThrow(/pass `boardId`/)
    await expect(new Resolver(io()).list('To Do')).rejects.toThrow(/pass `boardId`/)
    expect(await new Resolver(io(), 'Dice Inc').list('To Do')).toBe(ID(10))
  })

  it('resolves $refs and the names of things made earlier in the batch', async () => {
    const r = new Resolver(io(), ID(1))
    r.defineRef('sprint', ID(50))
    r.noteList(ID(1), 'Sprint 4', ID(50))
    r.noteLabel(ID(1), 'Perf', ID(60))
    expect(await r.list('$sprint')).toBe(ID(50))
    expect(await r.list('sprint 4')).toBe(ID(50))
    expect(await r.label('perf')).toBe(ID(60))
    expect(r.id('$sprint')).toBe(ID(50))
    expect(() => r.id('$nope')).toThrow(/Unknown ref \$nope/)
    expect(() => r.defineRef('sprint', ID(51))).toThrow(/used twice/)
  })

  it('does not read a board this batch is still creating', async () => {
    const deps = io()
    const r = new Resolver(deps)
    r.defineRef('b', ID(70))
    r.noteBoard(ID(70))
    r.noteList(ID(70), 'Inbox', ID(71))
    expect(await r.list('Inbox', '$b')).toBe(ID(71))
    expect(deps.boardView).not.toHaveBeenCalled()
  })

  it("tracks a card's labels across steps", async () => {
    const card = vi.fn(async () => ({ id: ID(100), boardId: ID(1), labelIds: [ID(20)] }) as CardView)
    const r = new Resolver(io({ card }))
    expect(await r.cardLabels(ID(100))).toEqual([ID(20)])
    r.noteCardLabels(ID(100), [ID(20), ID(21)])
    expect(await r.cardLabels(ID(100))).toEqual([ID(20), ID(21)])
    expect(await r.boardOfCard(ID(100))).toBe(ID(1))
  })
})
