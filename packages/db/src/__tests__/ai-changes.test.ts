import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { asc } from 'drizzle-orm'
import type { Mutation } from '@kanbini/shared'
import {
  AI_UNDO_GROUP_GAP_MS,
  AI_UNDO_GROUP_MAX,
  isAiUndoGroup,
  joinAiUndoGroup,
  markAiWrite,
  touchedCardIds
} from '../ai-changes'
import { applyMutation, ensureDefaultProjectId } from '../crud'
import { getBoardView, getCardView } from '../data'
import {
  MAX_UNDO_LOG_SIZE,
  applyMutationRecorded,
  applyMutationsRecorded,
  undoOne,
  undoStatus
} from '../undo'
import type { Db } from '../client'
import { undoLog } from '../schema'
import { createTestDb } from './_setup'

// Control-channel (AI) writes: one undo group per board for the AI's run
// since the user last did something there, and the cards each change
// touched (for the board view's glow).

let db: Db
let close: () => void

beforeEach(() => {
  const t = createTestDb()
  db = t.db
  close = t.close
})
afterEach(() => close())

function setup() {
  const projectId = ensureDefaultProjectId(db)
  const a = applyMutation(db, { type: 'board.create', projectId, name: 'A' }).id
  const b = applyMutation(db, { type: 'board.create', projectId, name: 'B' }).id
  const todo = applyMutation(db, { type: 'list.create', boardId: a, name: 'Todo' }).id
  const done = applyMutation(db, { type: 'list.create', boardId: a, name: 'Done' }).id
  const bList = applyMutation(db, { type: 'list.create', boardId: b, name: 'Inbox' }).id
  return { a, b, todo, done, bList }
}

/** What the control channel does for one `mutate` call. */
function ai(m: Mutation, now?: number) {
  const mark = markAiWrite(db)
  const result = applyMutationRecorded(db, m)
  joinAiUndoGroup(db, mark, now)
  return result
}

const titles = (boardId: string, listId: string) =>
  getBoardView(db, boardId)!.lists.find((l) => l.id === listId)!.cards.map((c) => c.title)

describe('AI undo groups', () => {
  it('one Ctrl+Z takes back the whole AI run on the board', () => {
    const s = setup()
    const one = ai({ type: 'card.create', listId: s.todo, title: 'One' }).id
    ai({ type: 'card.create', listId: s.todo, title: 'Two' })
    ai({ type: 'card.move', id: one, toListId: s.done })
    ai({ type: 'card.update', id: one, patch: { title: 'One, renamed' } })
    expect(undoStatus(db).undoDescription).toBe("The AI's changes (4 changes)")
    expect(undoOne(db, s.a).applied).toBe(true)
    expect(titles(s.a, s.todo)).toEqual([])
    expect(titles(s.a, s.done)).toEqual([])
    expect(undoStatus(db).canUndo).toBe(false)
  })

  it("the user's own edit on the board ends the AI's group", () => {
    const s = setup()
    ai({ type: 'card.create', listId: s.todo, title: 'AI one' })
    applyMutationRecorded(db, { type: 'card.create', listId: s.todo, title: 'Mine' })
    ai({ type: 'card.create', listId: s.todo, title: 'AI two' })
    ai({ type: 'card.create', listId: s.todo, title: 'AI three' })
    undoOne(db, s.a)
    expect(titles(s.a, s.todo)).toEqual(['AI one', 'Mine'])
    undoOne(db, s.a)
    expect(titles(s.a, s.todo)).toEqual(['AI one'])
    undoOne(db, s.a)
    expect(titles(s.a, s.todo)).toEqual([])
  })

  it('an undo by the user ends it too, even though the next AI write clears that redo', () => {
    const s = setup()
    ai({ type: 'card.create', listId: s.todo, title: 'AI one' })
    applyMutationRecorded(db, { type: 'card.create', listId: s.todo, title: 'Mine' })
    undoOne(db, s.a) // the user takes "Mine" back
    ai({ type: 'card.create', listId: s.todo, title: 'AI two' })
    undoOne(db, s.a)
    expect(titles(s.a, s.todo)).toEqual(['AI one'])
  })

  it('a pause longer than the gap starts a new group', () => {
    const s = setup()
    const t0 = Date.now()
    ai({ type: 'card.create', listId: s.todo, title: 'Morning' }, t0)
    ai({ type: 'card.create', listId: s.todo, title: 'Later' }, t0 + AI_UNDO_GROUP_GAP_MS + 60_000)
    undoOne(db, s.a)
    expect(titles(s.a, s.todo)).toEqual(['Morning'])
  })

  it('groups are per board, like undo', () => {
    const s = setup()
    ai({ type: 'card.create', listId: s.todo, title: 'On A' })
    ai({ type: 'card.create', listId: s.bList, title: 'On B' })
    ai({ type: 'card.create', listId: s.todo, title: 'On A again' })
    undoOne(db, s.a)
    expect(titles(s.a, s.todo)).toEqual([])
    expect(titles(s.b, s.bList)).toEqual(['On B'])
  })

  it("a user's bulk gesture stays its own group and isn't joined", () => {
    const s = setup()
    applyMutationsRecorded(db, [
      { type: 'card.create', listId: s.todo, title: 'Bulk 1' },
      { type: 'card.create', listId: s.todo, title: 'Bulk 2' }
    ])
    ai({ type: 'card.create', listId: s.todo, title: 'AI' })
    undoOne(db, s.a)
    expect(titles(s.a, s.todo)).toEqual(['Bulk 1', 'Bulk 2'])
  })

  it('an AI batch joins the run as well', () => {
    const s = setup()
    ai({ type: 'card.create', listId: s.todo, title: 'Single' })
    const mark = markAiWrite(db)
    applyMutationsRecorded(db, [
      { type: 'card.create', listId: s.todo, title: 'Batch 1' },
      { type: 'card.create', listId: s.todo, title: 'Batch 2' }
    ])
    joinAiUndoGroup(db, mark)
    expect(undoStatus(db).undoDescription).toBe("The AI's changes (3 changes)")
    undoOne(db, s.a)
    expect(titles(s.a, s.todo)).toEqual([])
  })

  it('a single AI change says so', () => {
    const s = setup()
    ai({ type: 'card.create', listId: s.todo, title: 'Solo' })
    expect(undoStatus(db).undoDescription).toBe('Create card "Solo" (by the AI)')
  })

  it('a write that records nothing joins nothing', () => {
    const s = setup()
    const card = applyMutation(db, { type: 'card.create', listId: s.todo, title: 'C' }).id
    const mark = markAiWrite(db)
    // A view-only patch isn't an undoable change.
    applyMutationRecorded(db, { type: 'card.update', id: card, patch: { collapsed: true } })
    expect(joinAiUndoGroup(db, mark)).toBeNull()
  })

  it('trimming the log to its cap never splits a long AI run', () => {
    const s = setup()
    for (let i = 0; i < MAX_UNDO_LOG_SIZE + 20; i++) {
      ai({ type: 'card.create', listId: s.todo, title: `Card ${i}` })
    }
    const rows = db.select({ groupId: undoLog.groupId }).from(undoLog).orderBy(asc(undoLog.id)).all()
    expect(rows).toHaveLength(MAX_UNDO_LOG_SIZE + 20)
    expect(new Set(rows.map((r) => r.groupId)).size).toBe(1)
    expect(isAiUndoGroup(rows[0]!.groupId)).toBe(true)
    undoOne(db, s.a)
    expect(titles(s.a, s.todo)).toEqual([])
  })

  it(`a run past ${AI_UNDO_GROUP_MAX} changes starts a new group, so the log can trim the old one`, () => {
    const s = setup()
    const card = applyMutation(db, { type: 'card.create', listId: s.todo, title: 'C' }).id
    for (let i = 0; i < AI_UNDO_GROUP_MAX + MAX_UNDO_LOG_SIZE + 5; i++) {
      ai({ type: 'card.update', id: card, patch: { title: `Title ${i}` } })
    }
    const groups = db.select({ groupId: undoLog.groupId }).from(undoLog).all().map((r) => r.groupId)
    // The first group went whole once the second one filled the cap.
    expect(new Set(groups).size).toBe(1)
    expect(groups).toHaveLength(MAX_UNDO_LOG_SIZE + 5)
  })

  it('the cap still trims ungrouped entries older than the AI run', () => {
    const s = setup()
    for (let i = 0; i < 30; i++) {
      applyMutationRecorded(db, { type: 'card.create', listId: s.todo, title: `Mine ${i}` })
    }
    for (let i = 0; i < MAX_UNDO_LOG_SIZE; i++) {
      ai({ type: 'card.create', listId: s.todo, title: `AI ${i}` })
    }
    expect(db.select().from(undoLog).all()).toHaveLength(MAX_UNDO_LOG_SIZE)
  })
})

describe('touchedCardIds', () => {
  it('names the card each kind of change touches', () => {
    const s = setup()
    const card = applyMutation(db, { type: 'card.create', listId: s.todo, title: 'C' }).id
    const cl = applyMutation(db, { type: 'checklist.create', cardId: card, name: 'Steps' }).id
    const item = applyMutation(db, { type: 'checklistItem.create', checklistId: cl, text: 'x' }).id
    const comment = applyMutation(db, { type: 'comment.create', cardId: card, body: 'hi' }).id
    const cases: [Mutation, string[]][] = [
      [{ type: 'card.update', id: card, patch: { title: 'D' } }, [card]],
      [{ type: 'card.move', id: card, toListId: s.done }, [card]],
      [{ type: 'checklist.create', cardId: card, name: 'More' }, [card]],
      [{ type: 'checklist.update', id: cl, patch: { name: 'Renamed' } }, [card]],
      [{ type: 'checklistItem.create', checklistId: cl, text: 'y' }, [card]],
      [{ type: 'checklistItem.update', id: item, patch: { completed: true } }, [card]],
      [{ type: 'checklistItem.delete', id: item }, [card]],
      [{ type: 'comment.update', id: comment, patch: { body: 'edited' } }, [card]],
      [{ type: 'label.create', boardId: s.a, name: 'L', color: 'red' }, []],
      [{ type: 'list.update', id: s.todo, patch: { name: 'Renamed' } }, []],
      [{ type: 'card.update', id: 'missing', patch: { title: 'x' } }, ['missing']],
      [{ type: 'checklistItem.delete', id: 'missing' }, []]
    ]
    for (const [m, expected] of cases) expect(touchedCardIds(db, m)).toEqual(expected)
  })

  it('a create names the new card from its result', () => {
    const s = setup()
    const m: Mutation = { type: 'card.create', listId: s.todo, title: 'New' }
    expect(touchedCardIds(db, m)).toEqual([])
    const result = applyMutation(db, m)
    expect(touchedCardIds(db, m, result)).toEqual([result.id])
    expect(getCardView(db, result.id)).not.toBeNull()
  })
})
