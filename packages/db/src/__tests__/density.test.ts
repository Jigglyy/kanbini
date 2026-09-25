import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyMutation, ensureDefaultProjectId } from '../crud'
import { getBoardView, getCardView } from '../data'
import { exportToFolder } from '../export'
import { importFromFolder } from '../import'
import { card as cardTable, list as listTable, template } from '../schema'
import {
  instantiateBoardTemplate,
  instantiateListTemplate,
  saveBoardTemplate,
  saveListTemplate
} from '../templates'
import { applyMutationRecorded, undoOne, undoStatus, redoOne } from '../undo'
import { type Db } from '../client'
import { createTestDb } from './_setup'

// Card density: per-card `collapsed` (three-state) and per-list
// `cardDensity` + `visibleCardLimit`. All three are VIEW settings - they
// change how the renderer draws a card, never the card itself - so the
// contract pinned here is: they persist and round-trip everywhere data
// does (board view, card view, snapshots, templates, export), but they
// stay out of the undo log and don't mark a card "recently updated".

let db: Db
let sqlite: Database.Database
let close: () => void
let projectId: string

beforeEach(() => {
  const t = createTestDb()
  db = t.db
  sqlite = t.sqlite
  close = t.close
  projectId = ensureDefaultProjectId(db)
})

afterEach(() => close())

function seed() {
  const board = applyMutation(db, { type: 'board.create', projectId, name: 'B' })
  const list = applyMutation(db, { type: 'list.create', boardId: board.id, name: 'L' })
  const card = applyMutation(db, { type: 'card.create', listId: list.id, title: 'C' })
  return { boardId: board.id, listId: list.id, cardId: card.id }
}

const viewList = (boardId: string) => getBoardView(db, boardId)!.lists[0]!
const viewCard = (boardId: string) => viewList(boardId).cards[0]!

describe('defaults', () => {
  it('a new card follows its list and a new list shows full cards, all of them', () => {
    const s = seed()
    expect(viewCard(s.boardId).collapsed).toBeNull()
    expect(viewList(s.boardId)).toMatchObject({ cardDensity: null, visibleCardLimit: null })
    expect(getCardView(db, s.cardId)?.collapsed).toBeNull()
  })
})

describe('writes', () => {
  it('card.update stores each collapse state', () => {
    const s = seed()
    for (const collapsed of [true, false, null] as const) {
      applyMutation(db, { type: 'card.update', id: s.cardId, patch: { collapsed } })
      expect(viewCard(s.boardId).collapsed).toBe(collapsed)
      expect(getCardView(db, s.cardId)?.collapsed).toBe(collapsed)
    }
  })

  it('list.update stores density and limit, and null clears them', () => {
    const s = seed()
    applyMutation(db, {
      type: 'list.update',
      id: s.listId,
      patch: { cardDensity: 'compact', visibleCardLimit: 20 }
    })
    expect(viewList(s.boardId)).toMatchObject({ cardDensity: 'compact', visibleCardLimit: 20 })
    applyMutation(db, {
      type: 'list.update',
      id: s.listId,
      patch: { cardDensity: null, visibleCardLimit: null }
    })
    expect(viewList(s.boardId)).toMatchObject({ cardDensity: null, visibleCardLimit: null })
  })

  it('the board view still returns every card past the visible limit', () => {
    const s = seed()
    for (let i = 0; i < 4; i++) {
      applyMutation(db, { type: 'card.create', listId: s.listId, title: `x${i}` })
    }
    applyMutation(db, { type: 'list.update', id: s.listId, patch: { visibleCardLimit: 2 } })
    expect(viewList(s.boardId).cards).toHaveLength(5)
  })

  it('a view-only patch leaves updatedAt alone', () => {
    const s = seed()
    const before = db.select().from(cardTable).where(eq(cardTable.id, s.cardId)).get()!
    const listBefore = db.select().from(listTable).where(eq(listTable.id, s.listId)).get()!
    applyMutation(db, { type: 'card.update', id: s.cardId, patch: { collapsed: true } })
    applyMutation(db, {
      type: 'list.update',
      id: s.listId,
      patch: { cardDensity: 'compact', visibleCardLimit: 10 }
    })
    expect(db.select().from(cardTable).where(eq(cardTable.id, s.cardId)).get()!.updatedAt).toBe(
      before.updatedAt
    )
    expect(db.select().from(listTable).where(eq(listTable.id, s.listId)).get()!.updatedAt).toBe(
      listBefore.updatedAt
    )
  })

  it('collapsing logs no activity row', () => {
    const s = seed()
    const before = getCardView(db, s.cardId)!.activities.length
    applyMutation(db, { type: 'card.update', id: s.cardId, patch: { collapsed: true } })
    expect(getCardView(db, s.cardId)!.activities.length).toBe(before)
  })
})

describe('soft-narrowing on read', () => {
  it('an unknown stored density reads as full cards', () => {
    const s = seed()
    sqlite.prepare('UPDATE list SET card_density = ? WHERE id = ?').run('titles', s.listId)
    expect(viewList(s.boardId).cardDensity).toBeNull()
  })

  it('a non-positive stored limit reads as show-all', () => {
    const s = seed()
    sqlite.prepare('UPDATE list SET visible_card_limit = ? WHERE id = ?').run(0, s.listId)
    expect(viewList(s.boardId).visibleCardLimit).toBeNull()
    sqlite.prepare('UPDATE list SET visible_card_limit = ? WHERE id = ?').run(-5, s.listId)
    expect(viewList(s.boardId).visibleCardLimit).toBeNull()
  })
})

describe('undo', () => {
  it('a collapse-only change is not undoable and keeps the redo tail', () => {
    const s = seed()
    applyMutationRecorded(db, { type: 'card.update', id: s.cardId, patch: { title: 'Edited' } })
    expect(undoOne(db, s.boardId).applied).toBe(true)
    expect(undoStatus(db).canRedo).toBe(true)

    // A view toggle in the middle of an undo session...
    applyMutationRecorded(db, { type: 'card.update', id: s.cardId, patch: { collapsed: true } })
    applyMutationRecorded(db, {
      type: 'list.update',
      id: s.listId,
      patch: { cardDensity: 'compact', visibleCardLimit: 10 }
    })
    // ...leaves the redo available, and the collapse itself stays put.
    expect(undoStatus(db).canRedo).toBe(true)
    expect(redoOne(db, s.boardId).applied).toBe(true)
    expect(viewCard(s.boardId)).toMatchObject({ title: 'Edited', collapsed: true })
  })

  it('undoing a mixed patch restores the content and keeps the collapse', () => {
    const s = seed()
    applyMutationRecorded(db, {
      type: 'card.update',
      id: s.cardId,
      patch: { title: 'New', collapsed: true }
    })
    expect(undoOne(db, s.boardId).applied).toBe(true)
    expect(viewCard(s.boardId)).toMatchObject({ title: 'C', collapsed: true })
  })

  it('delete + undo brings the view settings back with the entity', () => {
    const s = seed()
    applyMutation(db, { type: 'card.update', id: s.cardId, patch: { collapsed: false } })
    applyMutation(db, {
      type: 'list.update',
      id: s.listId,
      patch: { cardDensity: 'compact', visibleCardLimit: 5 }
    })
    applyMutationRecorded(db, { type: 'list.delete', id: s.listId })
    expect(getBoardView(db, s.boardId)!.lists).toHaveLength(0)
    expect(undoOne(db, s.boardId).applied).toBe(true)
    expect(viewList(s.boardId)).toMatchObject({ cardDensity: 'compact', visibleCardLimit: 5 })
    expect(viewCard(s.boardId).collapsed).toBe(false)
  })
})

describe('templates', () => {
  it('a board template carries list density, limit, and card collapse', () => {
    const s = seed()
    applyMutation(db, { type: 'card.update', id: s.cardId, patch: { collapsed: true } })
    applyMutation(db, {
      type: 'list.update',
      id: s.listId,
      patch: { cardDensity: 'compact', visibleCardLimit: 20 }
    })
    const { id } = saveBoardTemplate(db, s.boardId, 'T')
    const made = instantiateBoardTemplate(db, id)
    expect(viewList(made.boardId)).toMatchObject({ cardDensity: 'compact', visibleCardLimit: 20 })
    expect(viewCard(made.boardId).collapsed).toBe(true)
  })

  it('a list template carries them too', () => {
    const s = seed()
    const target = seed()
    applyMutation(db, { type: 'card.update', id: s.cardId, patch: { collapsed: true } })
    applyMutation(db, { type: 'list.update', id: s.listId, patch: { visibleCardLimit: 50 } })
    const { id } = saveListTemplate(db, s.listId, 'LT')
    const made = instantiateListTemplate(db, id, target.boardId)
    const lst = getBoardView(db, target.boardId)!.lists.find((l) => l.id === made.listId)!
    expect(lst).toMatchObject({ cardDensity: null, visibleCardLimit: 50 })
    expect(lst.cards[0]!.collapsed).toBe(true)
  })

  it('a template saved before these fields existed still instantiates', () => {
    const s = seed()
    const { id } = saveBoardTemplate(db, s.boardId, 'Old')
    // Strip the new keys from the stored payload, as an older build wrote it.
    const row = db.select().from(template).where(eq(template.id, id)).get()!
    const data = row.data as {
      lists: Array<Record<string, unknown> & { cards: Array<Record<string, unknown>> }>
    }
    for (const l of data.lists) {
      delete l.cardDensity
      delete l.visibleCardLimit
      for (const c of l.cards) delete c.collapsed
    }
    db.update(template).set({ data }).where(eq(template.id, id)).run()
    const made = instantiateBoardTemplate(db, id)
    expect(viewList(made.boardId)).toMatchObject({ cardDensity: null, visibleCardLimit: null })
    expect(viewCard(made.boardId).collapsed).toBeNull()
  })
})

describe('export / import', () => {
  it('round-trips the view settings', async () => {
    const s = seed()
    applyMutation(db, { type: 'card.update', id: s.cardId, patch: { collapsed: true } })
    applyMutation(db, {
      type: 'list.update',
      id: s.listId,
      patch: { cardDensity: 'compact', visibleCardLimit: 10 }
    })
    const ud = mkdtempSync(join(tmpdir(), 'kanbini-density-ud-'))
    const ud2 = mkdtempSync(join(tmpdir(), 'kanbini-density-ud2-'))
    const fresh = createTestDb()
    try {
      const exportRoot = join(ud, 'export')
      await exportToFolder(db, ud, exportRoot)
      await importFromFolder(fresh.db, ud2, exportRoot)
      const l = getBoardView(fresh.db, s.boardId)!.lists[0]!
      expect(l).toMatchObject({ cardDensity: 'compact', visibleCardLimit: 10 })
      expect(l.cards[0]!.collapsed).toBe(true)
    } finally {
      fresh.close()
      rmSync(ud, { recursive: true, force: true })
      rmSync(ud2, { recursive: true, force: true })
    }
  })
})
