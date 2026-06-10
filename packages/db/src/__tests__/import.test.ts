import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyMutation } from '../crud'
import { exportToFolder } from '../export'
import { importFromFolder, isSafeUserDataRelPath } from '../import'
import { listBoards } from '../data'
import { createTestDb, type TestDb } from './_setup'

// Restore-from-export hardening. The dump is untrusted input (an
// export can be shared between machines/people), and the import path
// WRITES files at each row's relPath - so a crafted "../../…" entry
// was a path traversal straight out of userData. The validation must
// also run BEFORE the wipe transaction: a bad dump should leave the
// existing DB exactly as it was.

describe('isSafeUserDataRelPath', () => {
  it('accepts well-formed attachment + background paths', () => {
    expect(isSafeUserDataRelPath('attachments/abc/file.png', 'attachments')).toBe(true)
    expect(
      isSafeUserDataRelPath('board-backgrounds/b1/bg.jpg', 'board-backgrounds')
    ).toBe(true)
  })

  it('rejects traversal, absolute, drive-letter, and mis-rooted paths', () => {
    expect(isSafeUserDataRelPath('attachments/../evil.txt', 'attachments')).toBe(false)
    expect(isSafeUserDataRelPath('../attachments/x.png', 'attachments')).toBe(false)
    expect(isSafeUserDataRelPath('attachments/a/../../x', 'attachments')).toBe(false)
    expect(isSafeUserDataRelPath('/etc/passwd', 'attachments')).toBe(false)
    expect(isSafeUserDataRelPath('\\\\server\\share\\x', 'attachments')).toBe(false)
    expect(isSafeUserDataRelPath('C:/Windows/evil.dll', 'attachments')).toBe(false)
    expect(isSafeUserDataRelPath('board-backgrounds/b/x.png', 'attachments')).toBe(false)
    expect(isSafeUserDataRelPath('attachments', 'attachments')).toBe(false)
    expect(isSafeUserDataRelPath('attachments//x.png', 'attachments')).toBe(false)
    expect(isSafeUserDataRelPath('attachments/./x.png', 'attachments')).toBe(false)
    expect(isSafeUserDataRelPath('attachments/a\0b/x.png', 'attachments')).toBe(false)
    expect(isSafeUserDataRelPath('', 'attachments')).toBe(false)
    expect(isSafeUserDataRelPath(null, 'attachments')).toBe(false)
  })

  it('accepts backslash separators only when every segment is clean', () => {
    expect(isSafeUserDataRelPath('attachments\\abc\\f.png', 'attachments')).toBe(true)
    expect(isSafeUserDataRelPath('attachments\\..\\evil', 'attachments')).toBe(false)
  })
})

describe('importFromFolder', () => {
  let t: TestDb
  let userDataDir: string
  let sourceRoot: string

  beforeEach(() => {
    t = createTestDb()
    userDataDir = mkdtempSync(join(tmpdir(), 'kanbini-import-ud-'))
    sourceRoot = mkdtempSync(join(tmpdir(), 'kanbini-import-src-'))
  })

  afterEach(() => {
    t.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(sourceRoot, { recursive: true, force: true })
  })

  it('round-trips a real export', async () => {
    applyMutation(t.db, { type: 'board.create', name: 'Round trip' })
    const exportRoot = join(userDataDir, 'export')
    await exportToFolder(t.db, userDataDir, exportRoot)

    const fresh = createTestDb()
    try {
      const freshUd = mkdtempSync(join(tmpdir(), 'kanbini-import-ud2-'))
      try {
        const summary = await importFromFolder(fresh.db, freshUd, exportRoot)
        expect(summary.counts.boards).toBe(1)
        expect(listBoards(fresh.db).map((b) => b.name)).toEqual(['Round trip'])
      } finally {
        rmSync(freshUd, { recursive: true, force: true })
      }
    } finally {
      fresh.close()
    }
  })

  it('refuses a dump with a traversal attachment path BEFORE wiping the DB', async () => {
    // Seed the live DB so we can prove the wipe never ran.
    applyMutation(t.db, { type: 'board.create', name: 'Keep me' })

    const evil = {
      schemaVersion: 1,
      formatVersion: 1,
      exportedAt: Date.now(),
      projects: [],
      boards: [],
      lists: [],
      cards: [],
      labels: [],
      cardLabels: [],
      checklists: [],
      checklistItems: [],
      comments: [],
      attachments: [
        {
          id: 'a1',
          cardId: 'c1',
          filename: 'evil.txt',
          relPath: '../../evil.txt',
          mime: 'text/plain',
          size: 4,
          createdAt: Date.now()
        }
      ],
      activities: []
    }
    writeFileSync(join(sourceRoot, 'kanbini.json'), JSON.stringify(evil), 'utf8')
    // Plant the source file the traversal would copy.
    writeFileSync(join(sourceRoot, 'evil.txt'), 'pwnd', 'utf8')

    await expect(
      importFromFolder(t.db, userDataDir, sourceRoot)
    ).rejects.toThrow(/unsafe attachment path/)

    // DB untouched - the seeded board survived.
    expect(listBoards(t.db).map((b) => b.name)).toEqual(['Keep me'])
    // Nothing escaped userDataDir (the traversal target would be its
    // grandparent, i.e. the tmp root).
    expect(existsSync(join(userDataDir, '..', 'evil.txt'))).toBe(false)
  })

  it('refuses a dump with a traversal board-background path', async () => {
    const evil = {
      schemaVersion: 1,
      formatVersion: 1,
      exportedAt: Date.now(),
      projects: [],
      boards: [
        {
          id: 'b1',
          projectId: 'p1',
          name: 'Evil',
          position: 'a0',
          background: { kind: 'image', relPath: 'board-backgrounds/../../x.png' },
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      ],
      lists: [],
      cards: [],
      labels: [],
      cardLabels: [],
      checklists: [],
      checklistItems: [],
      comments: [],
      attachments: [],
      activities: []
    }
    writeFileSync(join(sourceRoot, 'kanbini.json'), JSON.stringify(evil), 'utf8')

    await expect(
      importFromFolder(t.db, userDataDir, sourceRoot)
    ).rejects.toThrow(/unsafe board background path/)
  })

  it('refuses a truncated dump (missing table arrays) with a clear error', async () => {
    applyMutation(t.db, { type: 'board.create', name: 'Keep me' })
    writeFileSync(
      join(sourceRoot, 'kanbini.json'),
      JSON.stringify({ schemaVersion: 1, formatVersion: 1, exportedAt: 1, projects: [] }),
      'utf8'
    )
    await expect(
      importFromFolder(t.db, userDataDir, sourceRoot)
    ).rejects.toThrow(/missing the "boards" table/)
    expect(listBoards(t.db).map((b) => b.name)).toEqual(['Keep me'])
  })

  it('copies a legitimate attachment file into the attachments root', async () => {
    const dump = {
      schemaVersion: 1,
      formatVersion: 1,
      exportedAt: Date.now(),
      projects: [{ id: 'p1', name: 'P', createdAt: 1, updatedAt: 1 }],
      boards: [
        { id: 'b1', projectId: 'p1', name: 'B', position: 'a0', createdAt: 1, updatedAt: 1 }
      ],
      lists: [
        { id: 'l1', boardId: 'b1', name: 'L', position: 'a0', createdAt: 1, updatedAt: 1 }
      ],
      cards: [
        {
          id: 'c1', listId: 'l1', title: 'C', position: 'a0',
          listAddedAt: 1, createdAt: 1, updatedAt: 1
        }
      ],
      labels: [],
      cardLabels: [],
      checklists: [],
      checklistItems: [],
      comments: [],
      attachments: [
        {
          id: 'a1', cardId: 'c1', filename: 'pic.png',
          relPath: 'attachments/a1/pic.png', mime: 'image/png', size: 3,
          createdAt: 1
        }
      ],
      activities: []
    }
    writeFileSync(join(sourceRoot, 'kanbini.json'), JSON.stringify(dump), 'utf8')
    mkdirSync(join(sourceRoot, 'attachments', 'a1'), { recursive: true })
    writeFileSync(join(sourceRoot, 'attachments', 'a1', 'pic.png'), 'png')

    const summary = await importFromFolder(t.db, userDataDir, sourceRoot)
    expect(summary.counts.attachmentFilesCopied).toBe(1)
    expect(existsSync(join(userDataDir, 'attachments', 'a1', 'pic.png'))).toBe(true)
  })
})
