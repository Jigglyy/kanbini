import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { isInternalMutation } from '@kanbini/shared'
import { addAttachmentFromBytes, deleteAttachmentWithFile } from '../attachments'
import { applyMutation, ensureDefaultProjectId } from '../crud'
import { getBoardView, getCardView, listAttachmentDirs } from '../data'
import { applyMutationRecorded, applyMutationsRecorded, redoOne, undoOne, undoStatus } from '../undo'
import type { Db } from '../client'
import { activity, label } from '../schema'
import { createTestDb } from './_setup'

// Moving and copying cards, including onto another board. Labels belong to
// one board, so a card that lands elsewhere keeps its labels by name: the
// target board's label of the same name, or a new one created there with
// the same colour. Every case also checks that one Ctrl+Z puts things back
// (labels the move created go too) and that redo brings the same card back.

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
  const a = applyMutation(db, { type: 'board.create', projectId, name: 'Home' }).id
  const b = applyMutation(db, { type: 'board.create', projectId, name: 'Work' }).id
  const aTodo = applyMutation(db, { type: 'list.create', boardId: a, name: 'Todo' }).id
  const aDone = applyMutation(db, { type: 'list.create', boardId: a, name: 'Done' }).id
  const bInbox = applyMutation(db, { type: 'list.create', boardId: b, name: 'Inbox' }).id
  const urgentA = applyMutation(db, {
    type: 'label.create',
    boardId: a,
    name: 'Urgent',
    color: 'red'
  }).id
  const ideaA = applyMutation(db, {
    type: 'label.create',
    boardId: a,
    name: 'Idea',
    color: 'blue'
  }).id
  // Work already has an "urgent" label (different case + colour).
  const urgentB = applyMutation(db, {
    type: 'label.create',
    boardId: b,
    name: ' urgent ',
    color: 'orange'
  }).id
  const cardId = applyMutation(db, { type: 'card.create', listId: aTodo, title: 'Pay rent' }).id
  applyMutation(db, { type: 'card.setLabels', id: cardId, labelIds: [urgentA, ideaA] })
  const other = applyMutation(db, { type: 'card.create', listId: bInbox, title: 'Existing' }).id
  return { a, b, aTodo, aDone, bInbox, urgentA, ideaA, urgentB, cardId, other }
}

const titles = (boardId: string, listId: string): string[] =>
  getBoardView(db, boardId)!.lists.find((l) => l.id === listId)!.cards.map((c) => c.title)

const labelsOf = (boardId: string) =>
  db
    .select({ id: label.id, name: label.name, color: label.color })
    .from(label)
    .where(eq(label.boardId, boardId))
    .all()

describe('card.move to another board', () => {
  it('maps labels by name and creates the missing ones with the same colour', () => {
    const s = setup()
    applyMutationRecorded(db, { type: 'card.move', id: s.cardId, toListId: s.bInbox })
    const moved = getCardView(db, s.cardId)!
    const idea = labelsOf(s.b).find((l) => l.name === 'Idea')
    expect(idea?.color).toBe('blue')
    expect(new Set(moved.labelIds)).toEqual(new Set([s.urgentB, idea!.id]))
    expect(labelsOf(s.b)).toHaveLength(2)
    expect(titles(s.b, s.bInbox)).toEqual(['Existing', 'Pay rent'])
  })

  it('a raw applyMutation (no recorder) maps and creates labels too', () => {
    const s = setup()
    applyMutation(db, { type: 'card.move', id: s.cardId, toListId: s.bInbox })
    const names = getCardView(db, s.cardId)!.labelIds.map(
      (id) => labelsOf(s.b).find((l) => l.id === id)!.name
    )
    expect(names.sort()).toEqual([' urgent ', 'Idea'])
  })

  it('takes the card feed along to the new board', () => {
    const s = setup()
    applyMutationRecorded(db, { type: 'card.move', id: s.cardId, toListId: s.bInbox })
    const rows = db.select().from(activity).where(eq(activity.cardId, s.cardId)).all()
    expect(rows.length).toBeGreaterThan(1)
    expect(rows.every((r) => r.boardId === s.b)).toBe(true)
    const moved = rows.find((r) => r.type === 'moved')!
    expect(moved.data).toMatchObject({ toListName: 'Inbox', toBoardName: 'Work' })
  })

  it('one undo from the old board brings the card, its labels and number back and drops the created label', () => {
    const s = setup()
    const before = getCardView(db, s.cardId)!
    applyMutationRecorded(db, { type: 'card.move', id: s.cardId, toListId: s.bInbox })
    expect(undoOne(db, s.a).applied).toBe(true)
    const back = getCardView(db, s.cardId)!
    expect(back.boardId).toBe(s.a)
    expect(back.number).toBe(before.number)
    expect(new Set(back.labelIds)).toEqual(new Set([s.urgentA, s.ideaA]))
    expect(labelsOf(s.b).map((l) => l.id)).toEqual([s.urgentB])
    expect(db.select().from(activity).where(eq(activity.cardId, s.cardId)).all().every((r) => r.boardId === s.a)).toBe(true)
    expect(undoStatus(db).canUndo).toBe(false) // the setup applied raw, so that was all
  })

  it('redo moves it again with the same labels', () => {
    const s = setup()
    applyMutationRecorded(db, { type: 'card.move', id: s.cardId, toListId: s.bInbox })
    const firstLabels = new Set(getCardView(db, s.cardId)!.labelIds)
    undoOne(db, s.a)
    expect(redoOne(db, s.a).applied).toBe(true)
    const again = getCardView(db, s.cardId)!
    expect(again.boardId).toBe(s.b)
    expect(new Set(again.labelIds)).toEqual(firstLabels)
  })

  it('a bulk move of two cards creates a missing label once', () => {
    const s = setup()
    const second = applyMutation(db, { type: 'card.create', listId: s.aTodo, title: 'Buy milk' }).id
    applyMutation(db, { type: 'card.setLabels', id: second, labelIds: [s.ideaA] })
    applyMutationsRecorded(db, [
      { type: 'card.move', id: s.cardId, toListId: s.bInbox },
      { type: 'card.move', id: second, toListId: s.bInbox }
    ])
    expect(labelsOf(s.b).filter((l) => l.name === 'Idea')).toHaveLength(1)
    expect(undoOne(db, s.a).applied).toBe(true)
    expect(labelsOf(s.b)).toHaveLength(1)
    expect(titles(s.a, s.aTodo)).toEqual(['Pay rent', 'Buy milk'])
  })

  it('a move inside one board leaves labels alone', () => {
    const s = setup()
    applyMutationRecorded(db, { type: 'card.move', id: s.cardId, toListId: s.aDone })
    expect(new Set(getCardView(db, s.cardId)!.labelIds)).toEqual(new Set([s.urgentA, s.ideaA]))
  })

  it('external callers may not name the arrival labels', () => {
    expect(
      isInternalMutation({ type: 'card.move', id: 'c', toListId: 'l', labelIds: [] })
    ).toBe(true)
    expect(isInternalMutation({ type: 'card.move', id: 'c', toListId: 'l' })).toBe(false)
  })

  it('rejects arrival labels from another board', () => {
    const s = setup()
    expect(() =>
      applyMutation(db, {
        type: 'card.move',
        id: s.cardId,
        toListId: s.bInbox,
        labelIds: [s.urgentA]
      })
    ).toThrow(/different board/)
  })
})

describe('card.copy', () => {
  function enrich(cardId: string) {
    applyMutation(db, {
      type: 'card.update',
      id: cardId,
      patch: {
        description: 'Before the 1st',
        dueAt: 1_800_000_000_000,
        priority: 'high',
        repeat: { unit: 'month', every: 1 }
      }
    })
    const cl = applyMutation(db, { type: 'checklist.create', cardId, name: 'Steps' }).id
    const one = applyMutation(db, { type: 'checklistItem.create', checklistId: cl, text: 'Log in' }).id
    applyMutation(db, { type: 'checklistItem.create', checklistId: cl, text: 'Pay' })
    applyMutation(db, { type: 'checklistItem.update', id: one, patch: { completed: true } })
    applyMutation(db, { type: 'comment.create', cardId, body: 'stays behind' })
  }

  it('Duplicate: a copy right below the card with the same content', () => {
    const s = setup()
    enrich(s.cardId)
    applyMutation(db, { type: 'card.create', listId: s.aTodo, title: 'Next' })
    const res = applyMutationRecorded(db, {
      type: 'card.copy',
      id: s.cardId,
      toListId: s.aTodo,
      beforeId: s.cardId
    })
    expect(titles(s.a, s.aTodo)).toEqual(['Pay rent', 'Pay rent', 'Next'])
    const orig = getCardView(db, s.cardId)!
    const copy = getCardView(db, res.id)!
    expect(copy.id).not.toBe(orig.id)
    expect(copy.number).not.toBe(orig.number)
    expect(copy.description).toBe('Before the 1st')
    expect(copy.dueAt).toBe(orig.dueAt)
    expect(copy.priority).toBe('high')
    expect(copy.repeat).toEqual({ unit: 'month', every: 1 })
    expect(new Set(copy.labelIds)).toEqual(new Set(orig.labelIds))
    expect(copy.checklists.map((c) => c.name)).toEqual(['Steps'])
    expect(copy.checklists[0]!.items.map((i) => [i.text, i.completed])).toEqual([
      ['Log in', true],
      ['Pay', false]
    ])
    expect(copy.checklists[0]!.items[0]!.id).not.toBe(orig.checklists[0]!.items[0]!.id)
    expect(copy.comments).toEqual([])
    expect(copy.activities.map((a) => a.type)).toEqual(['copied'])
    expect(copy.activities[0]!.data).toMatchObject({ fromCardId: s.cardId, fromTitle: 'Pay rent' })
  })

  it('takes a new title when given one', () => {
    const s = setup()
    const res = applyMutation(db, {
      type: 'card.copy',
      id: s.cardId,
      toListId: s.aDone,
      title: 'Pay rent (June)'
    })
    expect(getCardView(db, res.id)!.title).toBe('Pay rent (June)')
    expect(titles(s.a, s.aDone)).toEqual(['Pay rent (June)'])
  })

  it('to another board: labels by name, the original stays put, top placement works', () => {
    const s = setup()
    const res = applyMutationRecorded(db, {
      type: 'card.copy',
      id: s.cardId,
      toListId: s.bInbox,
      afterId: s.other
    })
    expect(titles(s.b, s.bInbox)).toEqual(['Pay rent', 'Existing'])
    expect(titles(s.a, s.aTodo)).toEqual(['Pay rent'])
    const copy = getCardView(db, res.id)!
    expect(copy.boardId).toBe(s.b)
    expect(copy.labelIds).toContain(s.urgentB)
    expect(labelsOf(s.b).map((l) => l.name).sort()).toEqual([' urgent ', 'Idea'])
    expect(new Set(getCardView(db, s.cardId)!.labelIds)).toEqual(new Set([s.urgentA, s.ideaA]))
  })

  it('undo removes the copy and the label it created; redo brings back the same card', () => {
    const s = setup()
    const res = applyMutationRecorded(db, { type: 'card.copy', id: s.cardId, toListId: s.bInbox })
    const number = getCardView(db, res.id)!.number
    expect(undoStatus(db).undoDescription).toMatch(/Copy card/)
    expect(undoOne(db, s.a).applied).toBe(true)
    expect(getCardView(db, res.id)).toBeNull()
    expect(labelsOf(s.b).map((l) => l.id)).toEqual([s.urgentB])
    expect(redoOne(db, s.a).applied).toBe(true)
    const again = getCardView(db, res.id)!
    expect(again.number).toBe(number)
    expect(again.boardId).toBe(s.b)
    expect(again.labelIds).toHaveLength(2)
  })

  it('throws for a missing card or list', () => {
    const s = setup()
    expect(() => applyMutation(db, { type: 'card.copy', id: 'nope', toListId: s.aTodo })).toThrow(
      /card nope not found/
    )
    expect(() => applyMutation(db, { type: 'card.copy', id: s.cardId, toListId: 'nope' })).toThrow(
      /list nope not found/
    )
  })

  it('external callers may not name the copy number', () => {
    expect(isInternalMutation({ type: 'card.copy', id: 'c', toListId: 'l', number: 4 })).toBe(true)
    expect(isInternalMutation({ type: 'card.copy', id: 'c', toListId: 'l', newId: 'x' })).toBe(false)
  })
})

describe('copied attachments share files', () => {
  let userDataDir: string

  beforeEach(async () => {
    userDataDir = join(await mkdtemp(join(tmpdir(), 'kanbini-copy-test-')), 'userData')
    await mkdir(userDataDir, { recursive: true })
  })
  afterEach(async () => {
    await rm(join(userDataDir, '..'), { recursive: true, force: true })
  })

  it('copies rows (and the cover) that point at the same file, kept until the last one goes', async () => {
    const s = setup()
    const { attachment: att } = await addAttachmentFromBytes(db, {
      userDataDir,
      cardId: s.cardId,
      filename: 'receipt.png',
      bytes: new Uint8Array([1, 2, 3])
    })
    applyMutation(db, { type: 'card.update', id: s.cardId, patch: { coverAttachmentId: att.id } })
    const relPath = att.relPath
    const res = applyMutation(db, { type: 'card.copy', id: s.cardId, toListId: s.bInbox })
    const copy = getCardView(db, res.id)!
    expect(copy.attachments).toHaveLength(1)
    const copied = copy.attachments[0]!
    expect(copied.id).not.toBe(att.id)
    expect(copied.relPath).toBe(relPath)
    expect(copy.coverAttachmentId).toBe(copied.id)
    const file = join(userDataDir, relPath)

    // The original's attachment goes; the copy still uses the file.
    await deleteAttachmentWithFile(db, { userDataDir, id: att.id })
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file)).toEqual(Buffer.from([1, 2, 3]))
    // The GC sweep counts the original's folder as in use.
    expect(listAttachmentDirs(db)).toContain(att.id)

    // The last row goes: so does the file.
    await deleteAttachmentWithFile(db, { userDataDir, id: copied.id })
    expect(existsSync(file)).toBe(false)
  })
})
