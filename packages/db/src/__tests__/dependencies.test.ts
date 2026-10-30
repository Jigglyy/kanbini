import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isBlockedBy, zBoardView, zCardView } from '@kanbini/shared'
import { applyMutation } from '../crud'
import { getBoardView, getCardView } from '../data'
import { exportToFolder } from '../export'
import { importFromFolder } from '../import'
import { applyMutationRecorded, redoOne, undoOne, undoStatus } from '../undo'
import { type Db } from '../client'
import { createTestDb, type TestDb } from './_setup'

// "Waiting on" links (card_dependency). What this file pins:
//   • add / remove, with no-ops for an existing / missing link
//   • self-links, direct and transitive cycles, and missing cards rejected
//   • both views carry blockedBy + blocking with far-end context,
//     across boards, oldest link first
//   • one activity row per real change, on the waiting card
//   • undo / redo of add and remove; no-ops record nothing
//   • deleting either end cascades the link; undoing the delete (card,
//     list, board) restores it, but not when the other end is gone
//   • export -> import round-trips links; an older dump without the
//     table still imports

let t: TestDb
let db: Db

beforeEach(() => {
  t = createTestDb()
  db = t.db
})
afterEach(() => t.close())

function board(name: string): { boardId: string; listId: string } {
  const boardId = applyMutation(db, { type: 'board.create', name }).id
  const listId = applyMutation(db, {
    type: 'list.create',
    boardId,
    name: `${name} list`
  }).id
  return { boardId, listId }
}

const card = (listId: string, title: string): string =>
  applyMutation(db, { type: 'card.create', listId, title }).id

const link = (id: string, blockerId: string) =>
  applyMutation(db, { type: 'card.addBlocker', id, blockerId })
const unlink = (id: string, blockerId: string) =>
  applyMutation(db, { type: 'card.removeBlocker', id, blockerId })

const blockerIds = (id: string): string[] =>
  getCardView(db, id)!.blockedBy.map((r) => r.cardId)
const blockingIds = (id: string): string[] =>
  getCardView(db, id)!.blocking.map((r) => r.cardId)

function activityTypes(id: string): string[] {
  return getCardView(db, id)!.activities.map((a) => a.type)
}

describe('adding and removing links', () => {
  it('links two cards and shows both directions in both views', () => {
    const work = board('Work')
    const home = board('Home')
    const a = card(work.listId, 'Ship release')
    const b = card(home.listId, 'Buy stamps')
    link(a, b)

    const cardView = getCardView(db, a)!
    expect(zCardView.parse(cardView)).toEqual(cardView)
    expect(cardView.blockedBy).toEqual([
      {
        cardId: b,
        // Each card is #1 on its own board.
        number: 1,
        title: 'Buy stamps',
        completed: false,
        archived: false,
        boardId: home.boardId,
        boardName: 'Home',
        listName: 'Home list'
      }
    ])
    expect(cardView.blocking).toEqual([])
    expect(blockingIds(b)).toEqual([a])

    const boardView = getBoardView(db, work.boardId)!
    expect(zBoardView.parse(boardView)).toEqual(boardView)
    const inBoard = boardView.lists[0]!.cards.find((c) => c.id === a)!
    expect(inBoard.blockedBy).toEqual(cardView.blockedBy)
    expect(getBoardView(db, home.boardId)!.lists[0]!.cards[0]!.blocking).toEqual([
      {
        cardId: a,
        number: 1,
        title: 'Ship release',
        completed: false,
        archived: false,
        boardId: work.boardId,
        boardName: 'Work',
        listName: 'Work list'
      }
    ])
  })

  it('lists blockers oldest link first, not by card age', () => {
    const { listId } = board('W')
    const a = card(listId, 'A')
    const olderCard = card(listId, 'Older card')
    const newerCard = card(listId, 'Newer card')
    // Link the NEWER card first, a clear millisecond apart, so link
    // order and card-id order disagree.
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1_000_000)
    link(a, newerCard)
    now.mockReturnValue(1_000_005)
    link(a, olderCard)
    now.mockRestore()
    expect(blockerIds(a)).toEqual([newerCard, olderCard])
  })

  it('treats a repeated add and a missing remove as no-ops', () => {
    const { listId } = board('W')
    const a = card(listId, 'A')
    const b = card(listId, 'B')
    link(a, b)
    link(a, b)
    expect(blockerIds(a)).toEqual([b])
    unlink(a, b)
    unlink(a, b)
    expect(blockerIds(a)).toEqual([])
    expect(activityTypes(a).filter((x) => x.startsWith('blocker-'))).toEqual([
      'blocker-removed',
      'blocker-added'
    ])
  })

  it('logs the blocker title on the waiting card only', () => {
    const { listId } = board('W')
    const a = card(listId, 'A')
    const b = card(listId, 'The blocker')
    link(a, b)
    const row = getCardView(db, a)!.activities.find((x) => x.type === 'blocker-added')
    expect(row?.data).toEqual({ blockerId: b, blockerTitle: 'The blocker' })
    expect(activityTypes(b)).not.toContain('blocker-added')
  })

  it('rejects a self-link', () => {
    const { listId } = board('W')
    const a = card(listId, 'A')
    expect(() => link(a, a)).toThrow(/cannot wait on itself/)
  })

  it('rejects a direct cycle', () => {
    const { listId } = board('W')
    const a = card(listId, 'A')
    const b = card(listId, 'B')
    link(a, b)
    expect(() => link(b, a)).toThrow(/loop/)
    expect(blockerIds(b)).toEqual([])
  })

  it('rejects a cycle through other cards, but allows a diamond', () => {
    const { listId } = board('W')
    const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((x) => card(listId, x))
    link(a!, b!)
    link(b!, c!)
    link(c!, d!)
    expect(() => link(d!, a!)).toThrow(/loop/)
    // A second path to the same card is fine: not a loop.
    link(a!, c!)
    expect(blockerIds(a!)).toEqual([b, c])
  })

  it('rejects a missing card on either end', () => {
    const { listId } = board('W')
    const a = card(listId, 'A')
    expect(() => link(a, 'nope')).toThrow(/card nope not found/)
    expect(() => link('nope', a)).toThrow(/card nope not found/)
  })
})

describe('isBlockedBy', () => {
  it('is blocked only while a blocker is open', () => {
    const { listId } = board('W')
    const a = card(listId, 'A')
    const b = card(listId, 'B')
    const c = card(listId, 'C')
    link(a, b)
    link(a, c)
    expect(isBlockedBy(getCardView(db, a)!.blockedBy)).toBe(true)

    applyMutation(db, { type: 'card.update', id: b, patch: { completed: true } })
    expect(isBlockedBy(getCardView(db, a)!.blockedBy)).toBe(true)

    applyMutation(db, { type: 'card.update', id: c, patch: { archived: true } })
    const refs = getCardView(db, a)!.blockedBy
    expect(refs.map((r) => [r.completed, r.archived])).toEqual([
      [true, false],
      [false, true]
    ])
    expect(isBlockedBy(refs)).toBe(false)
  })
})

describe('undo / redo', () => {
  it('undoes and redoes an add', () => {
    const { boardId, listId } = board('W')
    const a = card(listId, 'A')
    const b = card(listId, 'B')
    applyMutationRecorded(db, { type: 'card.addBlocker', id: a, blockerId: b })
    expect(blockerIds(a)).toEqual([b])
    expect(undoStatus(db).undoDescription).toBe('Add "waiting on" link')

    expect(undoOne(db, boardId).applied).toBe(true)
    expect(blockerIds(a)).toEqual([])
    expect(redoOne(db, boardId).applied).toBe(true)
    expect(blockerIds(a)).toEqual([b])
  })

  it('undoes a remove', () => {
    const { boardId, listId } = board('W')
    const a = card(listId, 'A')
    const b = card(listId, 'B')
    link(a, b)
    applyMutationRecorded(db, { type: 'card.removeBlocker', id: a, blockerId: b })
    expect(blockerIds(a)).toEqual([])
    undoOne(db, boardId)
    expect(blockerIds(a)).toEqual([b])
  })

  it('records nothing for a no-op', () => {
    const { listId } = board('W')
    const a = card(listId, 'A')
    const b = card(listId, 'B')
    link(a, b)
    applyMutationRecorded(db, { type: 'card.addBlocker', id: a, blockerId: b })
    applyMutationRecorded(db, { type: 'card.removeBlocker', id: b, blockerId: a })
    expect(undoStatus(db).canUndo).toBe(false)
  })

  it('restores links both ways when a deleted card comes back', () => {
    const { boardId, listId } = board('W')
    const a = card(listId, 'A')
    const middle = card(listId, 'Middle')
    const c = card(listId, 'C')
    link(a, middle)
    link(middle, c)

    applyMutationRecorded(db, { type: 'card.delete', id: middle })
    expect(blockerIds(a)).toEqual([])
    expect(blockingIds(c)).toEqual([])

    undoOne(db, boardId)
    expect(blockerIds(a)).toEqual([middle])
    expect(blockerIds(middle)).toEqual([c])
  })

  it('restores links inside and out of a deleted list', () => {
    const other = board('Other')
    const { boardId, listId } = board('W')
    const a = card(listId, 'A')
    const b = card(listId, 'B')
    const outside = card(other.listId, 'Outside')
    link(a, b)
    link(outside, a)

    applyMutationRecorded(db, { type: 'list.delete', id: listId })
    expect(blockerIds(outside)).toEqual([])

    undoOne(db, boardId)
    expect(blockerIds(a)).toEqual([b])
    expect(blockerIds(outside)).toEqual([a])
  })

  it('restores a board, and skips a link whose other end is gone', () => {
    const other = board('Other')
    const { boardId, listId } = board('W')
    const a = card(listId, 'A')
    const keep = card(other.listId, 'Keep')
    const gone = card(other.listId, 'Gone')
    link(a, keep)
    link(a, gone)

    applyMutationRecorded(db, { type: 'board.delete', id: boardId })
    applyMutation(db, { type: 'card.delete', id: gone })
    undoOne(db, boardId)
    expect(blockerIds(a)).toEqual([keep])
  })
})

describe('export / import', () => {
  let userDataDir: string

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'kanbini-deps-'))
  })
  afterEach(() => rmSync(userDataDir, { recursive: true, force: true }))

  it('round-trips links', async () => {
    const { listId } = board('W')
    const a = card(listId, 'A')
    const b = card(listId, 'B')
    link(a, b)
    const root = join(userDataDir, 'export')
    const summary = await exportToFolder(db, userDataDir, root)
    expect(summary.counts.cardDependencies).toBe(1)

    const fresh = createTestDb()
    try {
      const imported = await importFromFolder(fresh.db, userDataDir, root)
      expect(imported.counts.cardDependencies).toBe(1)
      expect(getCardView(fresh.db, a)!.blockedBy).toEqual(getCardView(db, a)!.blockedBy)
    } finally {
      fresh.close()
    }
  })

  it('imports an export written before links existed', async () => {
    const { listId } = board('W')
    card(listId, 'A')
    const root = join(userDataDir, 'export')
    await exportToFolder(db, userDataDir, root)
    const path = join(root, 'kanbini.json')
    const dump = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    delete dump.cardDependencies
    writeFileSync(path, JSON.stringify(dump))

    const fresh = createTestDb()
    try {
      const imported = await importFromFolder(fresh.db, userDataDir, root)
      expect(imported.counts.cardDependencies).toBe(0)
      expect(imported.counts.cards).toBe(1)
    } finally {
      fresh.close()
    }
  })

  it('rejects a malformed links table before touching the DB', async () => {
    const { listId } = board('Keep me')
    card(listId, 'A')
    const root = join(userDataDir, 'export')
    await exportToFolder(db, userDataDir, root)
    const path = join(root, 'kanbini.json')
    const dump = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    dump.cardDependencies = 'oops'
    writeFileSync(path, JSON.stringify(dump))

    await expect(importFromFolder(db, userDataDir, root)).rejects.toThrow(
      /malformed "cardDependencies"/
    )
    expect(getBoardView(db)!.board.name).toBe('Keep me')
  })
})
