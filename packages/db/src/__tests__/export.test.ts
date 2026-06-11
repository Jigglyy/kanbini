import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyMutation, createAttachment } from '../crud'
import { exportToFolder } from '../export'
import { createTestDb, type TestDb } from './_setup'

// Export staging reuse: attachment files are content-immutable (written
// once under their id), so a re-export hardlinks the previous export's
// copy instead of re-copying every byte - the on-quit auto-backup used
// to slow down linearly with attachment count. Reuse is observable via
// inode identity: a hardlink shares the inode, a fresh copy mints one.

describe('exportToFolder attachment staging', () => {
  let t: TestDb
  let userDataDir: string

  beforeEach(() => {
    t = createTestDb()
    userDataDir = mkdtempSync(join(tmpdir(), 'kanbini-export-'))
  })

  afterEach(() => {
    t.close()
    rmSync(userDataDir, { recursive: true, force: true })
  })

  function seedWithAttachment(): string {
    const projectId = applyMutation(t.db, {
      type: 'project.create',
      name: 'P'
    }).id
    const boardId = applyMutation(t.db, {
      type: 'board.create',
      projectId,
      name: 'B'
    }).id
    const listId = applyMutation(t.db, {
      type: 'list.create',
      boardId,
      name: 'L'
    }).id
    const cardId = applyMutation(t.db, {
      type: 'card.create',
      listId,
      title: 'C'
    }).id
    const relPath = 'attachments/att-1/pic.png'
    mkdirSync(join(userDataDir, 'attachments', 'att-1'), { recursive: true })
    writeFileSync(join(userDataDir, relPath), 'png-bytes')
    createAttachment(t.db, {
      id: 'att-1',
      cardId,
      filename: 'pic.png',
      relPath,
      mime: 'image/png',
      size: 9
    })
    return relPath
  }

  it('re-export reuses the previous copy via hardlink (same inode)', async () => {
    const relPath = seedWithAttachment()
    const exportRoot = join(userDataDir, 'export')

    await exportToFolder(t.db, userDataDir, exportRoot)
    const firstIno = statSync(join(exportRoot, relPath), {
      bigint: true
    }).ino

    await exportToFolder(t.db, userDataDir, exportRoot)
    const secondStat = statSync(join(exportRoot, relPath), { bigint: true })

    // Hardlink reuse: the second export's file shares the first
    // export copy's inode. A fresh copy would have minted a new one.
    expect(secondStat.ino).toBe(firstIno)
    // And the bytes are still right.
    expect(readFileSync(join(exportRoot, relPath), 'utf8')).toBe('png-bytes')
  })

  it('a changed source file is re-copied, not reused', async () => {
    const relPath = seedWithAttachment()
    const exportRoot = join(userDataDir, 'export')
    await exportToFolder(t.db, userDataDir, exportRoot)
    const firstIno = statSync(join(exportRoot, relPath), {
      bigint: true
    }).ino

    // Rewrite the source (different bytes AND a fresh mtime).
    writeFileSync(join(userDataDir, relPath), 'new-bytes!')
    await exportToFolder(t.db, userDataDir, exportRoot)

    const second = statSync(join(exportRoot, relPath), { bigint: true })
    expect(second.ino).not.toBe(firstIno)
    expect(readFileSync(join(exportRoot, relPath), 'utf8')).toBe('new-bytes!')
  })

  it('a missing source file still skips without aborting the snapshot', async () => {
    const relPath = seedWithAttachment()
    rmSync(join(userDataDir, relPath))
    const exportRoot = join(userDataDir, 'export')
    const summary = await exportToFolder(t.db, userDataDir, exportRoot)
    expect(summary.counts.attachments).toBe(1)
  })
})
