import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DAILY_BACKUPS_KEPT,
  SAFETY_BACKUPS_KEPT,
  backupKind,
  backupPath,
  dailyBackupName,
  hasDailyBackup,
  listBackups,
  takeDailyBackup,
  takeSafetyBackup
} from '../backups'
import { applyMutation, createAttachment, ensureDefaultProjectId } from '../crud'
import { listBoards } from '../data'
import { exportToFolder } from '../export'
import { importFromFolder } from '../import'
import { createTestDb, type TestDb } from './_setup'

// Dated backups: today's quit-time export kept as backups/YYYY-MM-DD
// (hardlinked, so attachments aren't stored twice), the last 7 days kept,
// and a "before restore" copy straight from the DB before any restore.

let t: TestDb
let userDataDir: string
let exportRoot: string
let backupsRoot: string

beforeEach(() => {
  t = createTestDb()
  userDataDir = mkdtempSync(join(tmpdir(), 'kanbini-backups-'))
  exportRoot = join(userDataDir, 'export')
  backupsRoot = join(userDataDir, 'backups')
})

afterEach(() => {
  t.close()
  rmSync(userDataDir, { recursive: true, force: true })
})

function seed(name = 'Home'): { boardId: string; listId: string } {
  const projectId = ensureDefaultProjectId(t.db)
  const boardId = applyMutation(t.db, { type: 'board.create', projectId, name }).id
  const listId = applyMutation(t.db, { type: 'list.create', boardId, name: 'Todo' }).id
  applyMutation(t.db, { type: 'card.create', listId, title: 'One' })
  applyMutation(t.db, { type: 'card.create', listId, title: 'Two' })
  return { boardId, listId }
}

function seedAttachment(listId: string): string {
  const cardId = applyMutation(t.db, { type: 'card.create', listId, title: 'With file' }).id
  const id = 'att-1'
  const relPath = `attachments/${id}/photo.png`
  mkdirSync(join(userDataDir, 'attachments', id), { recursive: true })
  writeFileSync(join(userDataDir, relPath), 'PNGDATA')
  createAttachment(t.db, { id, cardId, filename: 'photo.png', relPath, mime: 'image/png', size: 7 })
  return relPath
}

const day = (y: number, m: number, d: number, h = 18) => new Date(y, m - 1, d, h, 30, 0)

describe('names', () => {
  it('daily names follow the local calendar day', () => {
    expect(dailyBackupName(day(2026, 3, 9, 23))).toBe('2026-03-09')
    expect(dailyBackupName(day(2026, 3, 10, 0))).toBe('2026-03-10')
  })

  it('only backup-shaped names resolve to a folder', () => {
    expect(backupKind('2026-10-30')).toBe('daily')
    expect(backupKind('2026-10-30_14-02-09-before-restore')).toBe('before-restore')
    expect(backupPath(backupsRoot, '2026-10-30')).toBe(join(backupsRoot, '2026-10-30'))
    for (const bad of ['..', '../export', '2026-10-30/../..', 'export', '2026-10-30.staging']) {
      expect(backupPath(backupsRoot, bad)).toBeNull()
    }
  })
})

describe('takeDailyBackup', () => {
  it('keeps the export as today’s backup, once a day', async () => {
    seed()
    await exportToFolder(t.db, userDataDir, exportRoot)
    const now = day(2026, 10, 30)
    expect(await takeDailyBackup({ exportRoot, backupsRoot, now })).toBe('2026-10-30')
    expect(await hasDailyBackup(backupsRoot, now)).toBe(true)
    expect(existsSync(join(backupsRoot, '2026-10-30', 'kanbini.json'))).toBe(true)
    // A second quit the same day leaves it alone.
    expect(await takeDailyBackup({ exportRoot, backupsRoot, now: day(2026, 10, 30, 22) })).toBeNull()
  })

  it('shares attachment files with the export instead of copying them', async () => {
    const { listId } = seed()
    const relPath = seedAttachment(listId)
    await exportToFolder(t.db, userDataDir, exportRoot)
    await takeDailyBackup({ exportRoot, backupsRoot, now: day(2026, 10, 30) })
    const inExport = statSync(join(exportRoot, relPath))
    const inBackup = statSync(join(backupsRoot, '2026-10-30', relPath))
    expect(inBackup.ino).toBe(inExport.ino)
  })

  it('is a real snapshot: later exports do not change it', async () => {
    const { listId } = seed()
    await exportToFolder(t.db, userDataDir, exportRoot)
    await takeDailyBackup({ exportRoot, backupsRoot, now: day(2026, 10, 30) })
    applyMutation(t.db, { type: 'card.create', listId, title: 'Three' })
    await exportToFolder(t.db, userDataDir, exportRoot)
    const [b] = await listBackups(backupsRoot)
    expect(b!.cards).toBe(2)
  })

  it(`keeps the newest ${DAILY_BACKUPS_KEPT} days`, async () => {
    seed()
    await exportToFolder(t.db, userDataDir, exportRoot)
    for (let d = 1; d <= DAILY_BACKUPS_KEPT + 3; d++) {
      await takeDailyBackup({ exportRoot, backupsRoot, now: day(2026, 10, d) })
    }
    const names = readdirSync(backupsRoot).sort()
    expect(names).toHaveLength(DAILY_BACKUPS_KEPT)
    expect(names[0]).toBe('2026-10-04')
    expect(names.at(-1)).toBe('2026-10-10')
  })
})

describe('takeSafetyBackup + listBackups', () => {
  it('writes the database as it is now, kept apart from the dailies', async () => {
    const { listId } = seed()
    await exportToFolder(t.db, userDataDir, exportRoot)
    await takeDailyBackup({ exportRoot, backupsRoot, now: day(2026, 10, 30) })
    applyMutation(t.db, { type: 'card.create', listId, title: 'Three' })
    const name = await takeSafetyBackup({
      db: t.db,
      userDataDir,
      exportRoot,
      backupsRoot,
      now: day(2026, 10, 30, 21)
    })
    expect(name).toBe('2026-10-30_21-30-00-before-restore')
    const list = await listBackups(backupsRoot)
    expect(list.map((b) => [b.kind, b.cards])).toEqual([
      ['before-restore', 3],
      ['daily', 2]
    ])
    expect(list[0]!.boards).toBe(1)
    expect(list[0]!.takenAt).toBeGreaterThanOrEqual(list[1]!.takenAt)
  })

  it(`keeps the newest ${SAFETY_BACKUPS_KEPT} safety copies`, async () => {
    seed()
    for (let m = 0; m < SAFETY_BACKUPS_KEPT + 2; m++) {
      await takeSafetyBackup({
        db: t.db,
        userDataDir,
        exportRoot,
        backupsRoot,
        now: new Date(2026, 9, 30, 12, m, 0)
      })
    }
    const names = readdirSync(backupsRoot).sort()
    expect(names).toHaveLength(SAFETY_BACKUPS_KEPT)
    expect(names[0]).toBe('2026-10-30_12-02-00-before-restore')
  })

  it('skips folders that are not readable backups', async () => {
    mkdirSync(join(backupsRoot, '2026-10-29'), { recursive: true }) // no kanbini.json
    mkdirSync(join(backupsRoot, 'notes'), { recursive: true })
    expect(await listBackups(backupsRoot)).toEqual([])
    expect(await listBackups(join(userDataDir, 'missing'))).toEqual([])
  })

  it('a backup restores like any export folder', async () => {
    seed('Before')
    await exportToFolder(t.db, userDataDir, exportRoot)
    await takeDailyBackup({ exportRoot, backupsRoot, now: day(2026, 10, 30) })
    applyMutation(t.db, { type: 'board.create', projectId: ensureDefaultProjectId(t.db), name: 'After' })
    await importFromFolder(t.db, userDataDir, backupPath(backupsRoot, '2026-10-30')!)
    expect(listBoards(t.db).map((b) => b.name)).toEqual(['Before'])
  })
})
