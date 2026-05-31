import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyMutation, ensureDefaultProjectId } from '../crud'
import { getBoardView, listBoards } from '../data'
import {
  deleteTemplate,
  instantiateBoardTemplate,
  instantiateListTemplate,
  listTemplates,
  renameTemplate,
  saveBoardTemplate,
  saveListTemplate
} from '../templates'
import { type Db } from '../client'
import { createTestDb } from './_setup'

// ADR-0038 · save / instantiate flows for board + list templates.
// Black-box: the assertions read through the public board view so
// schema details (label remap table, ordering keys) stay private.

let db: Db
let close: () => void
let projectId: string

beforeEach(() => {
  const t = createTestDb()
  db = t.db
  close = t.close
  projectId = ensureDefaultProjectId(db)
})

afterEach(() => close())

/** Build a small board: 2 lists, 3 cards, 2 labels, one checklist with
 *  items, and a colour. Cards #1 and #2 get a label each so the label
 *  remap survives instantiate. */
function seedRichBoard(): {
  boardId: string
  listAId: string
  listBId: string
  cardIds: string[]
  labelIds: string[]
} {
  const board = applyMutation(db, {
    type: 'board.create',
    projectId,
    name: 'Source'
  })
  applyMutation(db, {
    type: 'board.update',
    id: board.id,
    patch: { color: 'oklch(0.62 0.15 250)' }
  })
  const labelA = applyMutation(db, {
    type: 'label.create',
    boardId: board.id,
    name: 'Alpha',
    color: '#aaa'
  })
  const labelB = applyMutation(db, {
    type: 'label.create',
    boardId: board.id,
    name: 'Beta',
    color: '#bbb'
  })
  const listA = applyMutation(db, {
    type: 'list.create',
    boardId: board.id,
    name: 'Lane A',
    color: '#fa0'
  })
  const listB = applyMutation(db, {
    type: 'list.create',
    boardId: board.id,
    name: 'Lane B'
  })
  // Give Lane B a WIP limit and sort mode so they round-trip.
  applyMutation(db, {
    type: 'list.update',
    id: listB.id,
    patch: { wipLimit: 5, sortMode: 'created-desc' }
  })
  const c1 = applyMutation(db, {
    type: 'card.create',
    listId: listA.id,
    title: 'First card'
  })
  applyMutation(db, {
    type: 'card.update',
    id: c1.id,
    patch: { description: 'desc-1', priority: 'high' }
  })
  applyMutation(db, {
    type: 'card.setLabels',
    id: c1.id,
    labelIds: [labelA.id]
  })
  applyMutation(db, {
    type: 'checklist.create',
    cardId: c1.id,
    name: 'Steps'
  })
  const cl = getBoardView(db, board.id)!
    .lists.find((l) => l.id === listA.id)!
    .cards.find((c) => c.id === c1.id)!.checklists[0]!
  applyMutation(db, {
    type: 'checklistItem.create',
    checklistId: cl.id,
    text: 'one'
  })
  applyMutation(db, {
    type: 'checklistItem.create',
    checklistId: cl.id,
    text: 'two'
  })
  const c2 = applyMutation(db, {
    type: 'card.create',
    listId: listA.id,
    title: 'Second card'
  })
  applyMutation(db, {
    type: 'card.setLabels',
    id: c2.id,
    labelIds: [labelA.id, labelB.id]
  })
  const c3 = applyMutation(db, {
    type: 'card.create',
    listId: listB.id,
    title: 'Third card'
  })

  return {
    boardId: board.id,
    listAId: listA.id,
    listBId: listB.id,
    cardIds: [c1.id, c2.id, c3.id],
    labelIds: [labelA.id, labelB.id]
  }
}

describe('board templates', () => {
  it('save + instantiate round-trips structure, labels, cards, and checklists', () => {
    const src = seedRichBoard()
    const tpl = saveBoardTemplate(db, src.boardId, 'My Template')

    // Bookkeeping: the template lands as a 'board' summary row.
    const summaries = listTemplates(db)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      id: tpl.id,
      kind: 'board',
      name: 'My Template',
      listCount: 2,
      cardCount: 3
    })

    const r = instantiateBoardTemplate(db, tpl.id)
    expect(r.kind).toBe('board')
    expect(r.listId).toBeNull()
    expect(r.boardId).not.toBe(src.boardId) // fresh id

    const view = getBoardView(db, r.boardId)!
    expect(view.board.name).toBe('Source')
    expect(view.board.color).toBe('oklch(0.62 0.15 250)')
    expect(view.labels.map((l) => l.name).sort()).toEqual(['Alpha', 'Beta'])
    // None of the new label ids may collide with the source's - labels
    // are board-scoped and we mint fresh ids on instantiate.
    for (const lb of view.labels) expect(src.labelIds).not.toContain(lb.id)

    expect(view.lists.map((l) => l.name)).toEqual(['Lane A', 'Lane B'])
    const laneB = view.lists.find((l) => l.name === 'Lane B')!
    expect(laneB.wipLimit).toBe(5)
    expect(laneB.sortMode).toBe('created-desc')

    const laneA = view.lists.find((l) => l.name === 'Lane A')!
    expect(laneA.color).toBe('#fa0')
    expect(laneA.cards.map((c) => c.title)).toEqual([
      'First card',
      'Second card'
    ])

    const first = laneA.cards[0]!
    expect(first.description).toBe('desc-1')
    expect(first.priority).toBe('high')
    // Label assignments remapped to the NEW board's label ids.
    const alphaId = view.labels.find((l) => l.name === 'Alpha')!.id
    expect(first.labelIds).toEqual([alphaId])
    expect(first.checklists).toHaveLength(1)
    expect(first.checklists[0]!.name).toBe('Steps')
    expect(first.checklists[0]!.items.map((i) => i.text)).toEqual([
      'one',
      'two'
    ])

    const second = laneA.cards[1]!
    const betaId = view.labels.find((l) => l.name === 'Beta')!.id
    expect(second.labelIds.sort()).toEqual([alphaId, betaId].sort())
  })

  it('saving a board template does not mutate the source board', () => {
    const src = seedRichBoard()
    const before = JSON.stringify(getBoardView(db, src.boardId))
    saveBoardTemplate(db, src.boardId, 'snapshot')
    const after = JSON.stringify(getBoardView(db, src.boardId))
    expect(after).toBe(before)
  })

  it('two boards instantiated from the same template have independent ids', () => {
    const src = seedRichBoard()
    const tpl = saveBoardTemplate(db, src.boardId, 'twice')
    const a = instantiateBoardTemplate(db, tpl.id)
    const b = instantiateBoardTemplate(db, tpl.id)
    expect(a.boardId).not.toBe(b.boardId)
    const av = getBoardView(db, a.boardId)!
    const bv = getBoardView(db, b.boardId)!
    // No id overlap anywhere we surface ids.
    const aIds = new Set([
      ...av.labels.map((l) => l.id),
      ...av.lists.flatMap((l) => [l.id, ...l.cards.map((c) => c.id)])
    ])
    for (const bl of bv.labels) expect(aIds.has(bl.id)).toBe(false)
    for (const bl of bv.lists) {
      expect(aIds.has(bl.id)).toBe(false)
      for (const c of bl.cards) expect(aIds.has(c.id)).toBe(false)
    }
  })

  it('template payload survives source board deletion', () => {
    // Template should be fully self-contained - no FK reference to
    // the source board's labels / lists / cards. Deleting the source
    // must not break instantiate. (Sanity guard against a future
    // refactor that accidentally stores source ids in `data`.)
    const src = seedRichBoard()
    const tpl = saveBoardTemplate(db, src.boardId, 'self-contained')
    applyMutation(db, { type: 'board.delete', id: src.boardId })
    const r = instantiateBoardTemplate(db, tpl.id)
    const view = getBoardView(db, r.boardId)!
    expect(view.lists.map((l) => l.name)).toEqual(['Lane A', 'Lane B'])
    expect(view.labels.map((l) => l.name).sort()).toEqual(['Alpha', 'Beta'])
  })

  it('closed lists are excluded from the board snapshot', () => {
    const src = seedRichBoard()
    applyMutation(db, {
      type: 'list.update',
      id: src.listBId,
      patch: { closed: true }
    })
    const tpl = saveBoardTemplate(db, src.boardId, 'no-closed')
    const r = instantiateBoardTemplate(db, tpl.id)
    const view = getBoardView(db, r.boardId)!
    expect(view.lists.map((l) => l.name)).toEqual(['Lane A'])
  })
})

describe('list templates', () => {
  it('save + instantiate round-trips list + cards into the target board', () => {
    const src = seedRichBoard()
    const tpl = saveListTemplate(db, src.listAId, 'Lane A template')
    const sum = listTemplates(db)[0]!
    expect(sum.kind).toBe('list')
    expect(sum.cardCount).toBe(2)

    // Use a brand-new target board so we can confirm the list lands
    // there (not on the source).
    const targetBoard = applyMutation(db, {
      type: 'board.create',
      projectId,
      name: 'Target'
    })
    const r = instantiateListTemplate(db, tpl.id, targetBoard.id)
    expect(r.kind).toBe('list')
    expect(r.boardId).toBe(targetBoard.id)
    expect(r.listId).toBeTruthy()

    const view = getBoardView(db, targetBoard.id)!
    expect(view.lists).toHaveLength(1)
    const newList = view.lists[0]!
    expect(newList.name).toBe('Lane A')
    expect(newList.color).toBe('#fa0')
    expect(newList.cards.map((c) => c.title)).toEqual([
      'First card',
      'Second card'
    ])
    // Source board's label assignments are NOT carried - list templates
    // are board-agnostic so labels would be meaningless on the target.
    for (const c of newList.cards) expect(c.labelIds).toEqual([])
    // Card-internal content survives (checklists, priority).
    const first = newList.cards[0]!
    expect(first.priority).toBe('high')
    expect(first.checklists[0]!.items.map((i) => i.text)).toEqual([
      'one',
      'two'
    ])
  })

  it('instantiate appends the new list after existing ones on the target', () => {
    const src = seedRichBoard()
    const tpl = saveListTemplate(db, src.listAId, 'append')
    const target = applyMutation(db, {
      type: 'board.create',
      projectId,
      name: 'Target'
    })
    applyMutation(db, {
      type: 'list.create',
      boardId: target.id,
      name: 'Existing'
    })
    instantiateListTemplate(db, tpl.id, target.id)
    const view = getBoardView(db, target.id)!
    expect(view.lists.map((l) => l.name)).toEqual(['Existing', 'Lane A'])
  })

  it('throws when the target board is missing', () => {
    const src = seedRichBoard()
    const tpl = saveListTemplate(db, src.listAId, 'orphan')
    expect(() =>
      instantiateListTemplate(db, tpl.id, 'nonexistent-id')
    ).toThrow(/not found/)
  })
})

describe('template housekeeping', () => {
  it('rename + delete affect listTemplates', () => {
    const src = seedRichBoard()
    const tpl = saveBoardTemplate(db, src.boardId, 'first')
    renameTemplate(db, tpl.id, 'renamed')
    expect(listTemplates(db)[0]!.name).toBe('renamed')
    deleteTemplate(db, tpl.id)
    expect(listTemplates(db)).toHaveLength(0)
  })

  it('instantiating a board template never creates a duplicate project', () => {
    const src = seedRichBoard()
    const projectsBefore = listBoards(db).map((b) => b.projectId)
    const projectIds = new Set(projectsBefore)
    expect(projectIds.size).toBe(1)
    const tpl = saveBoardTemplate(db, src.boardId, 'reuse-project')
    instantiateBoardTemplate(db, tpl.id)
    const projectsAfter = listBoards(db).map((b) => b.projectId)
    expect(new Set(projectsAfter).size).toBe(1)
  })
})
