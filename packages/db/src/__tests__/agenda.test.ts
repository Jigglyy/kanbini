import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { localDayStart, zAgendaView } from '@kanbini/shared'
import { getAgenda } from '../agenda'
import { applyMutation, ensureDefaultProjectId } from '../crud'
import { type Db } from '../client'
import { createTestDb } from './_setup'
import type Database from 'better-sqlite3'

// getAgenda gathers candidates from SQLite and hands them to the shared
// buildAgendaView (section rules are pinned in @kanbini/shared's
// agenda.test.ts). What this file locks in is the SQL side:
//   • cross-board, with board / list context on every item
//   • archived cards, closed lists, archived boards are excluded
//   • completedAt = newest `completed` / `rule-completed` activity row
//   • a card completed with no activity row isn't "recently completed"
//   • reopening drops a card out of `completed` and back into its due slot

let db: Db
let sqlite: Database.Database
let close: () => void

beforeEach(() => {
  const t = createTestDb()
  db = t.db
  sqlite = t.sqlite
  close = t.close
})
afterEach(() => close())

const NOW = Date.now()
const day = (offset: number): number => localDayStart(NOW, offset)

function seedBoard(name: string, color?: string): { boardId: string; listId: string } {
  const projectId = ensureDefaultProjectId(db)
  const boardId = applyMutation(db, {
    type: 'board.create',
    projectId,
    name
  }).id
  if (color) {
    applyMutation(db, { type: 'board.update', id: boardId, patch: { color } })
  }
  const listId = applyMutation(db, {
    type: 'list.create',
    boardId,
    name: `${name} list`
  }).id
  return { boardId, listId }
}

function card(listId: string, title: string, dueAt?: number | null): string {
  const id = applyMutation(db, { type: 'card.create', listId, title }).id
  if (dueAt !== undefined) {
    applyMutation(db, { type: 'card.update', id, patch: { dueAt } })
  }
  return id
}

const complete = (id: string, completed = true): void => {
  applyMutation(db, { type: 'card.update', id, patch: { completed } })
}

const ids = (items: Array<{ cardId: string }>): string[] =>
  items.map((i) => i.cardId)

describe('getAgenda', () => {
  it('returns an empty, schema-valid agenda for an empty DB', () => {
    const v = getAgenda(db, { now: NOW })
    expect(zAgendaView.parse(v)).toEqual(v)
    expect(v.totals).toEqual({ overdue: 0, today: 0, upcoming: 0, completed: 0 })
  })

  it('collects due cards across boards with board + list context', () => {
    const a = seedBoard('Work', 'oklch(0.7 0.15 250)')
    const b = seedBoard('Home')
    const late = card(a.listId, 'Late', day(-1))
    const now = card(b.listId, 'Now', day(0))
    const soon = card(a.listId, 'Soon', day(3))
    card(b.listId, 'Far', day(30))
    card(a.listId, 'Undated')

    const v = getAgenda(db, { now: NOW })
    expect(ids(v.overdue)).toEqual([late])
    expect(ids(v.today)).toEqual([now])
    expect(ids(v.upcoming)).toEqual([soon])
    expect(v.overdue[0]).toMatchObject({
      title: 'Late',
      boardId: a.boardId,
      boardName: 'Work',
      boardColor: 'oklch(0.7 0.15 250)',
      listId: a.listId,
      listName: 'Work list',
      dueAt: day(-1),
      priority: null,
      completedAt: null
    })
    expect(v.today[0]!.boardColor).toBeNull()
  })

  it('carries priority through', () => {
    const { listId } = seedBoard('P')
    const id = card(listId, 'Hot', day(0))
    applyMutation(db, { type: 'card.update', id, patch: { priority: 'urgent' } })
    expect(getAgenda(db, { now: NOW }).today[0]!.priority).toBe('urgent')
  })

  it('excludes archived cards, closed lists, and archived boards', () => {
    const a = seedBoard('A')
    const archivedCard = card(a.listId, 'Archived card', day(0))
    applyMutation(db, {
      type: 'card.update',
      id: archivedCard,
      patch: { archived: true }
    })

    const b = seedBoard('B')
    card(b.listId, 'In closed list', day(0))
    applyMutation(db, { type: 'list.update', id: b.listId, patch: { closed: true } })

    const c = seedBoard('C')
    card(c.listId, 'On archived board', day(0))
    applyMutation(db, { type: 'board.update', id: c.boardId, patch: { archived: true } })

    const d = seedBoard('D')
    const visible = card(d.listId, 'Visible', day(0))

    expect(ids(getAgenda(db, { now: NOW }).today)).toEqual([visible])
  })

  it('moves a completed card from its due section into `completed`', () => {
    const { listId } = seedBoard('W')
    const id = card(listId, 'Done today', day(0))
    complete(id)

    const v = getAgenda(db, { now: NOW })
    expect(v.today).toEqual([])
    expect(ids(v.completed)).toEqual([id])
    expect(v.completed[0]!.completedAt).toBeGreaterThanOrEqual(NOW - 60_000)
    expect(v.completed[0]!.dueAt).toBe(day(0))
  })

  it('reopening puts the card back in its due section', () => {
    const { listId } = seedBoard('W')
    const id = card(listId, 'Flip-flop', day(-2))
    complete(id)
    complete(id, false)

    const v = getAgenda(db, { now: NOW })
    expect(ids(v.overdue)).toEqual([id])
    expect(v.overdue[0]!.completedAt).toBeNull()
    expect(v.completed).toEqual([])
  })

  it('uses the NEWEST completion activity as completedAt', () => {
    const { listId } = seedBoard('W')
    const id = card(listId, 'Twice')
    complete(id)
    complete(id, false)
    complete(id)
    // Backdate every completion row except the newest one.
    const rows = sqlite
      .prepare(
        `SELECT id FROM activity WHERE card_id = ? AND type = 'completed' ORDER BY created_at, id`
      )
      .all(id) as Array<{ id: string }>
    expect(rows).toHaveLength(2)
    sqlite
      .prepare('UPDATE activity SET created_at = ? WHERE id = ?')
      .run(day(-30), rows[0]!.id)
    const newest = day(-1) + 1234
    sqlite
      .prepare('UPDATE activity SET created_at = ? WHERE id = ?')
      .run(newest, rows[1]!.id)

    const v = getAgenda(db, { now: NOW })
    expect(v.completed.map((c) => c.completedAt)).toEqual([newest])
  })

  it('drops cards completed before the window', () => {
    const { listId } = seedBoard('W')
    const id = card(listId, 'Long ago')
    complete(id)
    sqlite
      .prepare(`UPDATE activity SET created_at = ? WHERE card_id = ? AND type = 'completed'`)
      .run(day(-8), id)

    expect(getAgenda(db, { now: NOW }).completed).toEqual([])
    expect(ids(getAgenda(db, { now: NOW, completedDays: 8 }).completed)).toEqual([id])
  })

  it('ignores a completed card with no completion activity (imported)', () => {
    const { listId } = seedBoard('W')
    const id = card(listId, 'Imported done')
    complete(id)
    sqlite.prepare('DELETE FROM activity WHERE card_id = ?').run(id)

    expect(getAgenda(db, { now: NOW }).completed).toEqual([])
  })

  it('counts a list on-enter auto-complete as a completion', () => {
    const { boardId, listId: todo } = seedBoard('Flow')
    const done = applyMutation(db, {
      type: 'list.create',
      boardId,
      name: 'Done'
    }).id
    applyMutation(db, {
      type: 'list.update',
      id: done,
      patch: { onEnter: { kind: 'complete' } }
    })
    const id = card(todo, 'Ship it', day(0))
    applyMutation(db, { type: 'card.move', id, toListId: done })

    const v = getAgenda(db, { now: NOW })
    expect(v.today).toEqual([])
    expect(v.completed).toHaveLength(1)
    expect(v.completed[0]).toMatchObject({ cardId: id, listName: 'Done' })
  })

  it('passes limit + windows through to the view', () => {
    const { listId } = seedBoard('W')
    for (let i = 0; i < 4; i++) card(listId, `T${i}`, day(0))
    card(listId, 'In 10 days', day(10))

    const v = getAgenda(db, { now: NOW, limit: 2, upcomingDays: 14 })
    expect(v.today).toHaveLength(2)
    expect(v.totals.today).toBe(4)
    expect(v.upcomingDays).toBe(14)
    expect(v.upcoming).toHaveLength(1)
  })
})
