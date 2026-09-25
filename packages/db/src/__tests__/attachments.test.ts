import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import {
  addAttachmentFromBytes,
  addAttachmentFromPath,
  addAttachmentFromRequest,
  decodeAttachmentContent,
  deleteAttachmentWithFile,
  mimeOf,
  sanitizeAttachmentFilename
} from '../attachments'
import { applyMutation, ensureDefaultProjectId } from '../crud'
import { getCardView } from '../data'
import { undoOne } from '../undo'
import { type Db } from '../client'
import { createTestDb } from './_setup'

// File-backed attachment writers. These run behind the renderer's file
// dialog + clipboard paste AND the MCP control channel, so they're the
// one place the "a caller-supplied name/path touches disk" safety lives.
// Everything runs against a real temp userData dir.

let db: Db
let close: () => void
let userDataDir: string
let scratch: string
let cardId: string

beforeEach(async () => {
  const t = createTestDb()
  db = t.db
  close = t.close
  const projectId = ensureDefaultProjectId(db)
  const board = applyMutation(db, { type: 'board.create', projectId, name: 'B' })
  const list = applyMutation(db, { type: 'list.create', boardId: board.id, name: 'L' })
  cardId = applyMutation(db, { type: 'card.create', listId: list.id, title: 'C' }).id
  const root = await mkdtemp(join(tmpdir(), 'kanbini-attach-test-'))
  userDataDir = join(root, 'userData')
  scratch = join(root, 'scratch')
  await mkdir(userDataDir, { recursive: true })
  await mkdir(scratch, { recursive: true })
})

afterEach(async () => {
  close()
  await rm(join(userDataDir, '..'), { recursive: true, force: true })
})

const attachmentsDir = () => join(userDataDir, 'attachments')
const storedDirs = () =>
  existsSync(attachmentsDir()) ? readdirSync(attachmentsDir()) : []

describe('sanitizeAttachmentFilename', () => {
  it('leaves an ordinary filename alone', () => {
    expect(sanitizeAttachmentFilename('report final (v2).pdf')).toBe(
      'report final (v2).pdf'
    )
  })

  it('neutralises path traversal', () => {
    expect(sanitizeAttachmentFilename('../../evil.txt')).toBe('_.._evil.txt')
    expect(sanitizeAttachmentFilename('..\\..\\evil.txt')).toBe('_.._evil.txt')
    expect(sanitizeAttachmentFilename('/etc/passwd')).toBe('_etc_passwd')
  })

  it('never returns "." / ".." / empty', () => {
    expect(sanitizeAttachmentFilename('..')).toBe('attachment')
    expect(sanitizeAttachmentFilename('.')).toBe('attachment')
    expect(sanitizeAttachmentFilename('   ')).toBe('attachment')
  })

  it('replaces characters Windows forbids and control chars', () => {
    expect(sanitizeAttachmentFilename('a<b>c:d"e|f?g*h.txt')).toBe(
      'a_b_c_d_e_f_g_h.txt'
    )
    expect(sanitizeAttachmentFilename('tab\there.txt')).toBe('tab_here.txt')
  })

  it('prefixes Windows reserved device names', () => {
    expect(sanitizeAttachmentFilename('CON')).toBe('_CON')
    expect(sanitizeAttachmentFilename('nul.txt')).toBe('_nul.txt')
    expect(sanitizeAttachmentFilename('COM1.log')).toBe('_COM1.log')
    // Not reserved: the device name has to be the whole base name.
    expect(sanitizeAttachmentFilename('console.txt')).toBe('console.txt')
  })

  it('strips trailing dots/spaces Windows would silently drop', () => {
    expect(sanitizeAttachmentFilename('notes.txt. . ')).toBe('notes.txt')
  })

  it('caps the length but keeps the extension', () => {
    const out = sanitizeAttachmentFilename(`${'x'.repeat(400)}.png`)
    expect(out.length).toBe(200)
    expect(out.endsWith('.png')).toBe(true)
  })
})

describe('mimeOf', () => {
  it('maps known extensions case-insensitively and nulls the rest', () => {
    expect(mimeOf('a.PNG')).toBe('image/png')
    expect(mimeOf('a.csv')).toBe('text/csv')
    expect(mimeOf('a.unknownext')).toBeNull()
  })
})

describe('decodeAttachmentContent', () => {
  it('passes utf8 through as bytes', () => {
    expect(Buffer.from(decodeAttachmentContent('héllo', 'utf8')).toString()).toBe(
      'héllo'
    )
  })

  it('decodes base64, tolerating line wraps', () => {
    const b64 = Buffer.from('hello world').toString('base64')
    const wrapped = `${b64.slice(0, 6)}\n${b64.slice(6)}`
    expect(Buffer.from(decodeAttachmentContent(wrapped, 'base64')).toString()).toBe(
      'hello world'
    )
  })

  it('rejects junk that Buffer would silently half-decode', () => {
    expect(() => decodeAttachmentContent('not base64!!', 'base64')).toThrow(
      /not valid base64/
    )
  })
})

describe('addAttachmentFromPath', () => {
  it('copies the file, inserts the row, and logs activity', async () => {
    const src = join(scratch, 'notes.md')
    await writeFile(src, '# hi')
    const { attachment, boardId } = await addAttachmentFromPath(db, {
      userDataDir,
      cardId,
      sourcePath: src
    })
    expect(boardId).toBeTruthy()
    expect(attachment).toMatchObject({
      filename: 'notes.md',
      mime: 'text/markdown',
      size: 4,
      relPath: `attachments/${attachment.id}/notes.md`
    })
    expect(
      readFileSync(join(userDataDir, attachment.relPath), 'utf8')
    ).toBe('# hi')
    const view = getCardView(db, cardId)!
    expect(view.attachments.map((a) => a.id)).toEqual([attachment.id])
    expect(view.activities[0]?.type).toBe('attachment-added')
  })

  it('rejects a relative path', async () => {
    await expect(
      addAttachmentFromPath(db, { userDataDir, cardId, sourcePath: 'notes.md' })
    ).rejects.toThrow(/must be absolute/)
  })

  it('rejects a missing file and a directory', async () => {
    await expect(
      addAttachmentFromPath(db, {
        userDataDir,
        cardId,
        sourcePath: join(scratch, 'nope.txt')
      })
    ).rejects.toThrow(/not found/)
    await expect(
      addAttachmentFromPath(db, { userDataDir, cardId, sourcePath: scratch })
    ).rejects.toThrow(/not a regular file/)
    expect(storedDirs()).toEqual([])
  })

  it('enforces the size cap', async () => {
    const src = join(scratch, 'big.bin')
    await writeFile(src, Buffer.alloc(64))
    await expect(
      addAttachmentFromPath(db, { userDataDir, cardId, sourcePath: src, maxBytes: 32 })
    ).rejects.toThrow(/over the 32-byte/)
    expect(storedDirs()).toEqual([])
  })

  it('leaves nothing on disk when the card does not exist', async () => {
    const src = join(scratch, 'a.txt')
    await writeFile(src, 'x')
    await expect(
      addAttachmentFromPath(db, {
        userDataDir,
        cardId: 'no-such-card',
        sourcePath: src
      })
    ).rejects.toThrow(/card no-such-card not found/)
    expect(storedDirs()).toEqual([])
  })
})

describe('addAttachmentFromBytes', () => {
  it('writes inline content under a sanitised name', async () => {
    const { attachment } = await addAttachmentFromBytes(db, {
      userDataDir,
      cardId,
      filename: '../../escape.txt',
      bytes: Buffer.from('safe')
    })
    expect(attachment.filename).toBe('_.._escape.txt')
    // Landed inside its own attachment dir, nowhere else.
    expect(storedDirs()).toEqual([attachment.id])
    expect(
      readFileSync(join(attachmentsDir(), attachment.id, '_.._escape.txt'), 'utf8')
    ).toBe('safe')
    expect(existsSync(join(userDataDir, 'escape.txt'))).toBe(false)
  })

  it('enforces the inline size cap', async () => {
    await expect(
      addAttachmentFromBytes(db, {
        userDataDir,
        cardId,
        filename: 'a.bin',
        bytes: Buffer.alloc(10),
        maxBytes: 5
      })
    ).rejects.toThrow(/over the 5-byte/)
    expect(storedDirs()).toEqual([])
  })
})

describe('addAttachmentFromRequest', () => {
  it('routes a path request to the file copy', async () => {
    const src = join(scratch, 'pic.png')
    await writeFile(src, Buffer.from([1, 2, 3]))
    const { attachment } = await addAttachmentFromRequest(db, {
      userDataDir,
      request: { cardId, path: src }
    })
    expect(attachment).toMatchObject({ filename: 'pic.png', mime: 'image/png', size: 3 })
  })

  it('routes an inline base64 request to the byte writer', async () => {
    const { attachment } = await addAttachmentFromRequest(db, {
      userDataDir,
      request: {
        cardId,
        filename: 'data.json',
        content: Buffer.from('{"a":1}').toString('base64'),
        encoding: 'base64'
      }
    })
    expect(attachment.mime).toBe('application/json')
    expect(
      readFileSync(join(userDataDir, attachment.relPath), 'utf8')
    ).toBe('{"a":1}')
  })
})

describe('deleteAttachmentWithFile', () => {
  it('removes the row, the file, and its directory', async () => {
    const { attachment } = await addAttachmentFromBytes(db, {
      userDataDir,
      cardId,
      filename: 'a.txt',
      bytes: Buffer.from('x')
    })
    await deleteAttachmentWithFile(db, { userDataDir, id: attachment.id })
    expect(getCardView(db, cardId)!.attachments).toEqual([])
    expect(storedDirs()).toEqual([])
  })

  it('clears the card cover when the cover is deleted', async () => {
    const { attachment } = await addAttachmentFromBytes(db, {
      userDataDir,
      cardId,
      filename: 'cover.png',
      bytes: Buffer.from([1])
    })
    applyMutation(db, {
      type: 'card.update',
      id: cardId,
      patch: { coverAttachmentId: attachment.id }
    })
    await deleteAttachmentWithFile(db, { userDataDir, id: attachment.id })
    expect(getCardView(db, cardId)!.coverAttachmentId).toBeNull()
  })

  it('is undo-recorded (the row comes back; the file does not)', async () => {
    const { attachment, boardId } = await addAttachmentFromBytes(db, {
      userDataDir,
      cardId,
      filename: 'a.txt',
      bytes: Buffer.from('x')
    })
    await deleteAttachmentWithFile(db, { userDataDir, id: attachment.id })
    expect(undoOne(db, boardId).applied).toBe(true)
    expect(getCardView(db, cardId)!.attachments.map((a) => a.id)).toEqual([
      attachment.id
    ])
    // Documented limitation - pinned so a fix is a deliberate change.
    expect(existsSync(join(userDataDir, attachment.relPath))).toBe(false)
  })

  it('never unlinks outside userData/attachments, even with a tampered relPath', async () => {
    const { attachment } = await addAttachmentFromBytes(db, {
      userDataDir,
      cardId,
      filename: 'a.txt',
      bytes: Buffer.from('x')
    })
    const victim = join(userDataDir, 'precious.txt')
    await writeFile(victim, 'keep me')
    // Point the stored relPath outside the attachments root (a hand-
    // edited DB, or an import of a crafted export).
    db.run(
      sql`UPDATE attachment SET rel_path = ${'precious.txt'} WHERE id = ${attachment.id}`
    )
    await deleteAttachmentWithFile(db, { userDataDir, id: attachment.id })
    expect(readFileSync(victim, 'utf8')).toBe('keep me')
  })
})
