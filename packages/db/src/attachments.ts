import { promises as fsp } from 'node:fs'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import { eq } from 'drizzle-orm'
import { newId, type AttachmentView } from '@kanbini/shared'
import type { Db } from './client'
import { createAttachment, getAttachmentRelPath } from './crud'
import { attachment, card } from './schema'
import { applyMutationRecorded } from './undo'

// File-backed attachment writes: the part of "attach a file" that has
// to touch disk as well as the DB. Lives here rather than in Electron
// main so there is ONE implementation behind every entry point - the
// renderer's file dialog + clipboard paste (IPC), the MCP control
// channel, and the MCP test suite's fake channel - and so it can be
// unit-tested against a temp dir without Electron.
//
// Layout (ADR-0017): `<userData>/attachments/<attachmentId>/<filename>`,
// with the POSIX-style relPath `attachments/<id>/<filename>` stored on
// the row and served through the `kanbini-file://` scheme.
//
// Undo: an ADD is not recorded (same as it always was from the UI); a
// DELETE goes through the recorder, and undo restores the row but not
// the file - the known limitation documented in CLAUDE.md.

/** Default cap for copying a file in from a caller-supplied path. The
 *  UI's own file dialog passes Infinity (a human picked the file); an
 *  automated caller gets a ceiling so one wrong path can't silently
 *  copy gigabytes into userData. */
export const ATTACHMENT_PATH_MAX_BYTES = 100 * 1024 * 1024

/** Cap for inline content (MCP `content` payloads). Bounded by the
 *  control channel's request-body cap too; this is the decoded size. */
export const ATTACHMENT_BYTES_MAX_BYTES = 10 * 1024 * 1024

/** Minimal extension -> MIME map (no extra dep). null for unknown. Also
 *  used by main's `kanbini-file://` handler to type what it serves. */
export function mimeOf(filename: string): string | null {
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    case 'avif':
      return 'image/avif'
    case 'bmp':
      return 'image/bmp'
    case 'ico':
      return 'image/x-icon'
    case 'svg':
      return 'image/svg+xml'
    case 'pdf':
      return 'application/pdf'
    case 'txt':
      return 'text/plain'
    case 'md':
      return 'text/markdown'
    case 'json':
      return 'application/json'
    case 'csv':
      return 'text/csv'
    default:
      return null
  }
}

// Windows refuses these as a file's base name, with or without an
// extension ("CON.txt" is as reserved as "CON").
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
// Path separators, the characters Windows forbids, and C0 controls.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g
const MAX_FILENAME_LENGTH = 200

/** Make a caller-supplied name safe to use as ONE path segment on every
 *  platform we build for. Inline content arrives with a name chosen by
 *  whoever called the tool, so this is the traversal guard: separators
 *  are replaced (never interpreted), `.` / `..` can't survive, and the
 *  result is never empty. A name that's already valid comes back
 *  unchanged, so real files picked from disk keep their names. */
export function sanitizeAttachmentFilename(name: string): string {
  let out = name.replace(UNSAFE_CHARS, '_')
  // Windows silently strips trailing dots/spaces, which would make the
  // stored relPath disagree with the file on disk. Leading ones are
  // trimmed too so `..` / `.` collapse to nothing.
  out = out.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')
  if (WINDOWS_RESERVED.test(out)) out = `_${out}`
  if (out.length > MAX_FILENAME_LENGTH) {
    // Keep the extension - it drives the MIME type and the renderer's
    // image preview.
    const dot = out.lastIndexOf('.')
    const ext = dot > 0 && out.length - dot <= 16 ? out.slice(dot) : ''
    out = out.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext
  }
  return out.length > 0 ? out : 'attachment'
}

export interface StoredAttachment {
  attachment: AttachmentView
  boardId: string | null
}

function assertCardExists(db: Db, cardId: string): void {
  const hit = db
    .select({ id: card.id })
    .from(card)
    .where(eq(card.id, cardId))
    .get()
  if (!hit) throw new Error(`card ${cardId} not found`)
}

/** Shared tail of both add paths: write the bytes (via `write`) into a
 *  fresh `<id>/` dir, insert the row, and roll the directory back if
 *  anything fails so a bad call leaves nothing behind for the GC sweep
 *  to find later. */
async function storeAttachment(
  db: Db,
  opts: {
    userDataDir: string
    cardId: string
    filename: string
    mime: string | null
    write: (dest: string) => Promise<void>
  }
): Promise<StoredAttachment> {
  assertCardExists(db, opts.cardId)
  const filename = sanitizeAttachmentFilename(opts.filename)
  const id = newId()
  const destDir = join(opts.userDataDir, 'attachments', id)
  const dest = resolve(destDir, filename)
  // Belt and braces on top of the sanitiser: the resolved file MUST be
  // a direct child of its own attachment directory.
  if (!dest.startsWith(resolve(destDir) + sep)) {
    throw new Error(`refusing unsafe attachment filename: ${opts.filename}`)
  }
  await fsp.mkdir(destDir, { recursive: true })
  try {
    await opts.write(dest)
    const { size } = await fsp.stat(dest)
    const relPath = `attachments/${id}/${filename}`
    const { boardId } = createAttachment(db, {
      id,
      cardId: opts.cardId,
      filename,
      relPath,
      mime: opts.mime,
      size
    })
    const row = db
      .select({ createdAt: attachment.createdAt })
      .from(attachment)
      .where(eq(attachment.id, id))
      .get()
    return {
      attachment: {
        id,
        filename,
        relPath,
        mime: opts.mime,
        size,
        sourceUrl: null,
        sourceTitle: null,
        createdAt: row?.createdAt ?? Date.now()
      },
      boardId
    }
  } catch (e) {
    await fsp.rm(destDir, { recursive: true, force: true }).catch(() => {})
    throw e
  }
}

/** Copy a file from disk onto a card. `sourcePath` must be absolute
 *  (a relative one would resolve against whichever process happens to
 *  run this, which is never what the caller meant) and must be a
 *  regular file no larger than `maxBytes`. */
export async function addAttachmentFromPath(
  db: Db,
  opts: {
    userDataDir: string
    cardId: string
    sourcePath: string
    maxBytes?: number
  }
): Promise<StoredAttachment> {
  const { sourcePath } = opts
  const maxBytes = opts.maxBytes ?? ATTACHMENT_PATH_MAX_BYTES
  if (!isAbsolute(sourcePath)) {
    throw new Error(`path must be absolute: ${sourcePath}`)
  }
  let stat
  try {
    stat = await fsp.stat(sourcePath)
  } catch {
    throw new Error(`file not found: ${sourcePath}`)
  }
  if (!stat.isFile()) throw new Error(`not a regular file: ${sourcePath}`)
  if (stat.size > maxBytes) {
    throw new Error(
      `file is ${stat.size} bytes, over the ${maxBytes}-byte attachment limit: ${sourcePath}`
    )
  }
  const filename = basename(sourcePath)
  return storeAttachment(db, {
    userDataDir: opts.userDataDir,
    cardId: opts.cardId,
    filename,
    mime: mimeOf(sanitizeAttachmentFilename(filename)),
    write: (dest) => fsp.copyFile(sourcePath, dest)
  })
}

/** Write in-memory content onto a card as a new attachment (clipboard
 *  paste, MCP inline content). `mime` defaults from the extension. */
export async function addAttachmentFromBytes(
  db: Db,
  opts: {
    userDataDir: string
    cardId: string
    filename: string
    bytes: Uint8Array
    mime?: string | null
    maxBytes?: number
  }
): Promise<StoredAttachment> {
  const maxBytes = opts.maxBytes ?? ATTACHMENT_BYTES_MAX_BYTES
  if (opts.bytes.length > maxBytes) {
    throw new Error(
      `content is ${opts.bytes.length} bytes, over the ${maxBytes}-byte attachment limit`
    )
  }
  const safe = sanitizeAttachmentFilename(opts.filename)
  return storeAttachment(db, {
    userDataDir: opts.userDataDir,
    cardId: opts.cardId,
    filename: opts.filename,
    mime: opts.mime !== undefined ? opts.mime : mimeOf(safe),
    write: (dest) => fsp.writeFile(dest, opts.bytes)
  })
}

/** Delete an attachment's row (undo-recorded, like every mutation) AND
 *  its file + directory. The relPath is read BEFORE the row goes, and
 *  the unlink is confined to `<userData>/attachments/` so a tampered
 *  relPath can never point the delete somewhere else. */
export async function deleteAttachmentWithFile(
  db: Db,
  opts: { userDataDir: string; id: string }
): Promise<{ id: string; boardId: string | null }> {
  const attachmentsRoot = resolve(opts.userDataDir, 'attachments')
  const rel = getAttachmentRelPath(db, opts.id)
  let toUnlink: string | null = null
  if (rel) {
    const abs = resolve(opts.userDataDir, rel)
    if (abs.startsWith(attachmentsRoot + sep)) toUnlink = abs
  }
  const result = applyMutationRecorded(db, {
    type: 'attachment.delete',
    id: opts.id
  })
  if (toUnlink) {
    await fsp.unlink(toUnlink).catch(() => {
      /* already gone */
    })
    await fsp.rmdir(resolve(toUnlink, '..')).catch(() => {
      /* not empty / already gone */
    })
  }
  return result
}

const BASE64_BODY = /^[A-Za-z0-9+/]*={0,2}$/

/** Decode inline attachment content. `Buffer.from(x, 'base64')` quietly
 *  skips characters it doesn't recognise, so junk input would land as a
 *  silently garbled file; validate the alphabet first and fail loudly
 *  instead. Whitespace (line-wrapped base64) is allowed. */
export function decodeAttachmentContent(
  content: string,
  encoding: 'utf8' | 'base64'
): Uint8Array {
  if (encoding === 'utf8') return Buffer.from(content, 'utf8')
  const compact = content.replace(/\s+/g, '')
  if (!BASE64_BODY.test(compact) || compact.length % 4 === 1) {
    throw new Error('content is not valid base64')
  }
  return Buffer.from(compact, 'base64')
}

/** The control channel's `attachment.add`, in one place so the desktop
 *  channel and the MCP suite's fake channel run the same code: pick the
 *  source from the request shape and hand off to the matching writer. */
export async function addAttachmentFromRequest(
  db: Db,
  opts: {
    userDataDir: string
    request:
      | { cardId: string; path: string }
      | {
          cardId: string
          filename: string
          content: string
          encoding: 'utf8' | 'base64'
        }
  }
): Promise<StoredAttachment> {
  const { request: req, userDataDir } = opts
  if ('path' in req) {
    return addAttachmentFromPath(db, {
      userDataDir,
      cardId: req.cardId,
      sourcePath: req.path
    })
  }
  return addAttachmentFromBytes(db, {
    userDataDir,
    cardId: req.cardId,
    filename: req.filename,
    bytes: decodeAttachmentContent(req.content, req.encoding)
  })
}
