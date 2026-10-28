import { describe, expect, it } from 'vitest'
import type { BoardView } from '@kanbini/shared'
import { hiddenCardReason } from '../hidden-card'

// A board with two lists: Todo (open: a labelled card + a plain one, one
// of them completed) and an archived-away "closed" list.
function board(): BoardView {
  const card = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    title: id.toUpperCase(),
    labelIds: [] as string[],
    completed: false,
    ...extra
  })
  return {
    board: { id: 'b1', name: 'Board' },
    labels: [{ id: 'lab', name: 'Bug', color: 'red' }],
    lists: [
      {
        id: 'todo',
        name: 'Todo',
        closed: false,
        cards: [
          card('tagged', { labelIds: ['lab'] }),
          card('plain'),
          card('done', { completed: true }),
          card('done-tagged', { completed: true, labelIds: ['lab'] })
        ]
      },
      { id: 'old', name: 'Old', closed: true, cards: [card('in-closed')] }
    ]
  } as unknown as BoardView
}

const LABEL = new Set(['lab'])
const NONE = new Set<string>()

describe('hiddenCardReason', () => {
  it('names the label filter when that is what hides the card', () => {
    expect(hiddenCardReason(board(), 'plain', LABEL, false)).toEqual({
      title: 'PLAIN',
      byLabels: true,
      byCompleted: false
    })
  })

  it('names Hide completed when that is what hides the card', () => {
    expect(hiddenCardReason(board(), 'done', NONE, true)).toMatchObject({
      byLabels: false,
      byCompleted: true
    })
  })

  it('names both when both hide it', () => {
    expect(hiddenCardReason(board(), 'done', LABEL, true)).toMatchObject({
      byLabels: true,
      byCompleted: true
    })
  })

  it('only blames what actually hides it', () => {
    // Carries the filtered label, so only Hide completed is in the way.
    expect(hiddenCardReason(board(), 'done-tagged', LABEL, true)).toMatchObject({
      byLabels: false,
      byCompleted: true
    })
  })

  it('is null when no filter hides the card', () => {
    expect(hiddenCardReason(board(), 'tagged', LABEL, true)).toBeNull()
  })

  it('is null for a card in a closed list or not on the board', () => {
    expect(hiddenCardReason(board(), 'in-closed', LABEL, true)).toBeNull()
    expect(hiddenCardReason(board(), 'nope', LABEL, true)).toBeNull()
  })
})
