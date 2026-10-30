import { promises as fsp } from 'node:fs'
import { extname, join } from 'node:path'
import { and, asc, desc, eq, getTableColumns } from 'drizzle-orm'
import { strFromU8, strToU8, unzipSync, zipSync, type Unzipped, type Zippable } from 'fflate'
import {
  BOARD_FILE_FORMAT,
  BOARD_FILE_JSON,
  BOARD_FILE_VERSION,
  type BoardBackground,
  type BoardFile,
  type BoardFileContent,
  type BoardImportSummary,
  newId,
  orderKeysBetween,
  zBoardFile,
  zBoardFileHeader
} from '@kanbini/shared'
import { sanitizeAttachmentFilename } from './attachments'
import type { Db } from './client'
import { ensureDefaultProjectId } from './crud'
import {
  parseBackground,
  parseCardDensity,
  parseListSortMode,
  parseOnEnter,
  parsePriority,
  parseSwimlaneMode,
  parseVisibleCardLimit
} from './data'
import { isSafeUserDataRelPath } from './import'
import { parseRepeat } from './repeat'
import {
  activity,
  attachment,
  board,
  card,
  cardDependency,
  cardLabel,
  checklist,
  checklistItem,
  comment,
  label,
  list
} from './schema'

// One board in one `.kanbini` file (the format is described in
// @kanbini/shared board-file.ts). Export reads the board straight from the
// database and packs the files its attachments and background point at;
// import makes a NEW board from the file with fresh ids, so it never
// touches existing boards and the same file can come in any number of
// times. Unlike the folder export (the whole database, restored by
// replacing everything), this is for moving or sharing a single board.
//
// The zip is built in memory, so BOARD_FILE_MAX_BYTES caps what an import
// will unpack. Attachments are stored uncompressed (they're mostly images,
// already compressed); board.json is deflated.

/** The most an import unpacks, in total. */
export const BOARD_FILE_MAX_BYTES = 1024 ** 3

const NOT_A_BOARD_FILE = "That isn't a Kanbini board file. Pick a .kanbini file exported from a board."
const TOO_BIG = 'That board file is too big to import (over 1 GB unpacked).'
const NEWER = 'That board was exported by a newer version of Kanbini. Update Kanbini to import it.'
const DAMAGED = "That board file is damaged or incomplete, so it can't be imported."

/** A userData relPath as a zip entry name (always `/`-separated). */
const zipName = (relPath: string): string => relPath.split(/[/\\]/).join('/')

/** Sort by stored position, id as the tiebreak (SQLite's byte order). */
const byPosition = <T extends { position: string; id: string }>(a: T, b: T): number =>
  a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const row of rows) {
    const k = key(row)
    const group = out.get(k)
    if (group) group.push(row)
    else out.set(k, [row])
  }
  return out
}

async function readOrNull(path: string): Promise<Uint8Array | null> {
  try {
    return await fsp.readFile(path)
  } catch {
    return null
  }
}

// ---- export -----------------------------------------------------------

/** Everything `board.json` holds for `boardId`. 'lists' leaves out the
 *  cards (and everything on them) and closed lists. */
export function buildBoardFile(
  db: Db,
  boardId: string,
  content: BoardFileContent,
  exportedAt: number = Date.now()
): BoardFile {
  const b = db.select().from(board).where(eq(board.id, boardId)).get()
  if (!b) throw new Error(`board ${boardId} not found`)
  const labels = db
    .select()
    .from(label)
    .where(eq(label.boardId, boardId))
    .orderBy(asc(label.id))
    .all()
  const lists = db
    .select()
    .from(list)
    .where(
      content === 'lists'
        ? and(eq(list.boardId, boardId), eq(list.closed, false))
        : eq(list.boardId, boardId)
    )
    .orderBy(asc(list.position), asc(list.id))
    .all()

  const file: BoardFile = {
    format: BOARD_FILE_FORMAT,
    version: BOARD_FILE_VERSION,
    exportedAt,
    content,
    board: {
      name: b.name,
      description: b.description,
      color: b.color,
      background: parseBackground(b.background),
      swimlaneMode: b.swimlaneMode,
      cardNumberLast: content === 'cards' ? b.cardNumberLast : 0
    },
    labels: labels.map((l) => ({
      id: l.id,
      name: l.name,
      color: l.color,
      createdAt: l.createdAt,
      updatedAt: l.updatedAt
    })),
    lists: lists.map((l) => ({
      id: l.id,
      name: l.name,
      color: l.color,
      position: l.position,
      closed: l.closed,
      wipLimit: l.wipLimit,
      sortMode: l.sortMode,
      onEnter: l.onEnter ?? null,
      cardDensity: l.cardDensity,
      visibleCardLimit: l.visibleCardLimit,
      createdAt: l.createdAt,
      updatedAt: l.updatedAt
    })),
    cards: [],
    cardLabels: [],
    cardDependencies: [],
    checklists: [],
    checklistItems: [],
    comments: [],
    attachments: [],
    activities: []
  }
  if (content === 'lists') return file

  const onBoard = eq(list.boardId, boardId)
  const cards = db
    .select(getTableColumns(card))
    .from(card)
    .innerJoin(list, eq(list.id, card.listId))
    .where(onBoard)
    .orderBy(asc(card.id))
    .all()
  const cardIds = new Set(cards.map((c) => c.id))
  file.cards = cards.map((c) => ({
    id: c.id,
    listId: c.listId,
    number: c.number,
    title: c.title,
    description: c.description,
    position: c.position,
    dueAt: c.dueAt,
    completed: c.completed,
    archived: c.archived,
    coverAttachmentId: c.coverAttachmentId,
    priority: c.priority,
    listAddedAt: c.listAddedAt,
    collapsed: c.collapsed,
    repeat: c.repeat ?? null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt
  }))
  file.cardLabels = db
    .select(getTableColumns(cardLabel))
    .from(cardLabel)
    .innerJoin(card, eq(card.id, cardLabel.cardId))
    .innerJoin(list, eq(list.id, card.listId))
    .where(onBoard)
    .orderBy(asc(cardLabel.cardId), asc(cardLabel.labelId))
    .all()
  // A link to a card on another board can't come along.
  file.cardDependencies = db
    .select(getTableColumns(cardDependency))
    .from(cardDependency)
    .innerJoin(card, eq(card.id, cardDependency.cardId))
    .innerJoin(list, eq(list.id, card.listId))
    .where(onBoard)
    .orderBy(asc(cardDependency.cardId), asc(cardDependency.blockerId))
    .all()
    .filter((d) => cardIds.has(d.blockerId))
  file.checklists = db
    .select(getTableColumns(checklist))
    .from(checklist)
    .innerJoin(card, eq(card.id, checklist.cardId))
    .innerJoin(list, eq(list.id, card.listId))
    .where(onBoard)
    .orderBy(asc(checklist.id))
    .all()
  file.checklistItems = db
    .select(getTableColumns(checklistItem))
    .from(checklistItem)
    .innerJoin(checklist, eq(checklist.id, checklistItem.checklistId))
    .innerJoin(card, eq(card.id, checklist.cardId))
    .innerJoin(list, eq(list.id, card.listId))
    .where(onBoard)
    .orderBy(asc(checklistItem.id))
    .all()
  file.comments = db
    .select(getTableColumns(comment))
    .from(comment)
    .innerJoin(card, eq(card.id, comment.cardId))
    .innerJoin(list, eq(list.id, card.listId))
    .where(onBoard)
    .orderBy(asc(comment.id))
    .all()
  file.attachments = db
    .select(getTableColumns(attachment))
    .from(attachment)
    .innerJoin(card, eq(card.id, attachment.cardId))
    .innerJoin(list, eq(list.id, card.listId))
    .where(onBoard)
    .orderBy(asc(attachment.id))
    .all()
  file.activities = db
    .select({
      id: activity.id,
      cardId: activity.cardId,
      type: activity.type,
      data: activity.data,
      createdAt: activity.createdAt
    })
    .from(activity)
    .where(eq(activity.boardId, boardId))
    .orderBy(asc(activity.id))
    .all()
    .map((a) => ({ ...a, data: a.data ?? null }))
  return file
}

export interface BoardFileExportResult {
  path: string
  bytes: number
  /** Attachments whose file was missing on disk, left out. */
  skippedAttachments: number
}

/** Write `boardId` to `destPath` as a `.kanbini` file. Written next to it
 *  first and renamed into place, so a failed export never leaves half a
 *  file where the user asked for one. */
export async function exportBoardFile(
  db: Db,
  opts: { userDataDir: string; boardId: string; content: BoardFileContent; destPath: string }
): Promise<BoardFileExportResult> {
  const data = buildBoardFile(db, opts.boardId, opts.content)
  const files: Zippable = {}

  // One entry per file: copies of a card share their attachments' files.
  const missing = new Set<string>()
  for (const relPath of new Set(data.attachments.map((a) => a.relPath))) {
    const bytes = isSafeUserDataRelPath(relPath, 'attachments')
      ? await readOrNull(join(opts.userDataDir, relPath))
      : null
    if (bytes) files[zipName(relPath)] = [bytes, { level: 0 }]
    else missing.add(relPath)
  }
  const before = data.attachments.length
  data.attachments = data.attachments.filter((a) => !missing.has(a.relPath))
  const kept = new Set(data.attachments.map((a) => a.id))
  for (const c of data.cards) {
    if (c.coverAttachmentId && !kept.has(c.coverAttachmentId)) c.coverAttachmentId = null
  }

  const bg = parseBackground(data.board.background)
  if (bg?.kind === 'image') {
    const bytes = isSafeUserDataRelPath(bg.relPath, 'board-backgrounds')
      ? await readOrNull(join(opts.userDataDir, bg.relPath))
      : null
    if (bytes) files[zipName(bg.relPath)] = [bytes, { level: 0 }]
    else data.board.background = null
  }

  files[BOARD_FILE_JSON] = [strToU8(JSON.stringify(data, null, 2)), { level: 6 }]
  const zipped = zipSync(files)
  const part = `${opts.destPath}.part`
  try {
    await fsp.writeFile(part, zipped)
    await fsp.rename(part, opts.destPath)
  } catch (err) {
    await fsp.rm(part, { force: true }).catch(() => {})
    throw err
  }
  return {
    path: opts.destPath,
    bytes: zipped.length,
    skippedAttachments: before - data.attachments.length
  }
}

// ---- import -----------------------------------------------------------

class TooBig extends Error {}

/** Unpack and validate a `.kanbini` file. Throws a message fit to show
 *  the user when it isn't one, is too big, or is from a newer build. */
export async function readBoardFile(
  path: string
): Promise<{ data: BoardFile; files: Unzipped }> {
  const stat = await fsp.stat(path)
  if (stat.size > BOARD_FILE_MAX_BYTES) throw new Error(TOO_BIG)
  const buf = await fsp.readFile(path)
  let files: Unzipped
  try {
    let total = 0
    files = unzipSync(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), {
      filter: (f) => {
        total += f.originalSize
        if (total > BOARD_FILE_MAX_BYTES) throw new TooBig()
        return true
      }
    })
  } catch (err) {
    throw new Error(err instanceof TooBig ? TOO_BIG : NOT_A_BOARD_FILE)
  }
  const json = files[BOARD_FILE_JSON]
  if (!json) throw new Error(NOT_A_BOARD_FILE)
  let raw: unknown
  try {
    raw = JSON.parse(strFromU8(json))
  } catch {
    throw new Error(NOT_A_BOARD_FILE)
  }
  const header = zBoardFileHeader.safeParse(raw)
  if (!header.success) throw new Error(NOT_A_BOARD_FILE)
  if (header.data.version > BOARD_FILE_VERSION) throw new Error(NEWER)
  const parsed = zBoardFile.safeParse(raw)
  if (!parsed.success || header.data.version !== BOARD_FILE_VERSION) {
    throw new Error(DAMAGED)
  }
  return { data: parsed.data, files }
}

/** A file extension safe to put on a background image's file name. */
function imageExt(relPath: string): string {
  const ext = extname(relPath).toLowerCase()
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '.png'
}

/** Import the `.kanbini` file at `path` as a new board, appended to the
 *  boards home. Files are written first (into fresh folders named by the
 *  new ids) and removed again if the database part fails. Not recorded
 *  for undo, like the Trello import and templates: deleting the board
 *  (which is undoable) takes it back. */
export async function importBoardFile(
  db: Db,
  opts: { userDataDir: string; path: string }
): Promise<BoardImportSummary> {
  const { data, files } = await readBoardFile(opts.path)
  const boardId = newId()
  const fresh = (rows: { id: string }[]): Map<string, string> =>
    new Map(rows.map((r) => [r.id, newId()]))

  const labelIds = fresh(data.labels)
  const listIds = fresh(data.lists)
  const cards = data.cards.filter((c) => listIds.has(c.listId))
  const cardIds = fresh(cards)
  const attachments = data.attachments.filter((a) => cardIds.has(a.cardId))
  const attachmentIds = fresh(attachments)

  // Files. Each distinct file goes into the folder of the first
  // attachment that uses it (the usual `attachments/<id>/<name>`); the
  // entry is looked up by the stored relPath but never written there.
  const written: string[] = []
  const newRelPath = new Map<string, string>()
  let background: BoardBackground | null = parseBackground(data.board.background)
  try {
    for (const a of attachments) {
      if (newRelPath.has(a.relPath)) continue
      const bytes = files[zipName(a.relPath)]
      if (!bytes) continue
      const folder = attachmentIds.get(a.id)!
      const name = sanitizeAttachmentFilename(a.relPath.split(/[/\\]/).pop() ?? a.filename)
      const dir = join(opts.userDataDir, 'attachments', folder)
      await fsp.mkdir(dir, { recursive: true })
      written.push(dir)
      await fsp.writeFile(join(dir, name), bytes)
      newRelPath.set(a.relPath, `attachments/${folder}/${name}`)
    }
    if (background?.kind === 'image') {
      const bytes = files[zipName(background.relPath)]
      if (bytes) {
        const name = `${newId()}${imageExt(background.relPath)}`
        const dir = join(opts.userDataDir, 'board-backgrounds', boardId)
        await fsp.mkdir(dir, { recursive: true })
        written.push(dir)
        await fsp.writeFile(join(dir, name), bytes)
        background = { kind: 'image', relPath: `board-backgrounds/${boardId}/${name}` }
      } else {
        background = null
      }
    }
  } catch (err) {
    await removeAll(written)
    throw err
  }

  const keptAttachments = attachments.filter((a) => newRelPath.has(a.relPath))
  const kept = new Set(keptAttachments.map((a) => a.id))
  const projectId = ensureDefaultProjectId(db)
  try {
    db.transaction((tx) => {
      const lastBoardPos =
        tx
          .select({ p: board.position })
          .from(board)
          .where(eq(board.projectId, projectId))
          .orderBy(desc(board.position))
          .limit(1)
          .get()?.p ?? null
      tx.insert(board)
        .values({
          id: boardId,
          projectId,
          name: data.board.name,
          description: data.board.description,
          color: data.board.color,
          position: orderKeysBetween(lastBoardPos, null, 1)[0]!,
          background,
          swimlaneMode: parseSwimlaneMode(data.board.swimlaneMode),
          cardNumberLast: data.board.cardNumberLast
        })
        .run()

      for (const l of data.labels) {
        tx.insert(label)
          .values({
            id: labelIds.get(l.id)!,
            boardId,
            name: l.name,
            color: l.color,
            createdAt: l.createdAt,
            updatedAt: l.updatedAt
          })
          .run()
      }

      // Positions are minted afresh in the stored order, so a damaged
      // key in the file can't break ordering later.
      const lists = [...data.lists].sort(byPosition)
      const listKeys = orderKeysBetween(null, null, lists.length)
      lists.forEach((l, i) => {
        tx.insert(list)
          .values({
            id: listIds.get(l.id)!,
            boardId,
            name: l.name,
            color: l.color,
            position: listKeys[i]!,
            closed: l.closed,
            wipLimit:
              typeof l.wipLimit === 'number' && Number.isInteger(l.wipLimit) && l.wipLimit > 0
                ? l.wipLimit
                : null,
            sortMode: parseListSortMode(l.sortMode),
            onEnter: parseOnEnter(l.onEnter),
            cardDensity: parseCardDensity(l.cardDensity),
            visibleCardLimit: parseVisibleCardLimit(l.visibleCardLimit),
            createdAt: l.createdAt,
            updatedAt: l.updatedAt
          })
          .run()
      })

      // Cards keep their numbers (the new board has none yet). A number
      // that's missing or used twice gets the next free one instead,
      // after every kept number is in, so the two can't collide.
      const cardKey = new Map<string, string>()
      for (const group of groupBy(cards, (c) => c.listId).values()) {
        const sorted = group.sort(byPosition)
        const keys = orderKeysBetween(null, null, sorted.length)
        sorted.forEach((c, i) => cardKey.set(c.id, keys[i]!))
      }
      const seen = new Set<number>()
      const keepsNumber = (n: number | null): n is number => {
        if (n === null || !Number.isInteger(n) || n <= 0 || seen.has(n)) return false
        seen.add(n)
        return true
      }
      const numbered = cards.map((c) => ({ c, number: keepsNumber(c.number) ? c.number : undefined }))
      for (const { c, number } of [
        ...numbered.filter((x) => x.number !== undefined),
        ...numbered.filter((x) => x.number === undefined)
      ]) {
        const cover =
          c.coverAttachmentId && kept.has(c.coverAttachmentId)
            ? attachmentIds.get(c.coverAttachmentId)!
            : null
        tx.insert(card)
          .values({
            id: cardIds.get(c.id)!,
            listId: listIds.get(c.listId)!,
            number,
            title: c.title,
            description: c.description,
            position: cardKey.get(c.id)!,
            dueAt: c.dueAt,
            completed: c.completed,
            archived: c.archived,
            coverAttachmentId: cover,
            priority: parsePriority(c.priority),
            listAddedAt: c.listAddedAt,
            collapsed: c.collapsed,
            repeat: parseRepeat(c.repeat),
            createdAt: c.createdAt,
            updatedAt: c.updatedAt
          })
          .run()
      }

      const pairs = new Set<string>()
      for (const cl of data.cardLabels) {
        const cardId = cardIds.get(cl.cardId)
        const labelId = labelIds.get(cl.labelId)
        if (!cardId || !labelId || pairs.has(`${cardId}:${labelId}`)) continue
        pairs.add(`${cardId}:${labelId}`)
        tx.insert(cardLabel).values({ cardId, labelId }).run()
      }
      const links = new Set<string>()
      for (const d of data.cardDependencies) {
        const cardId = cardIds.get(d.cardId)
        const blockerId = cardIds.get(d.blockerId)
        if (!cardId || !blockerId || cardId === blockerId) continue
        if (links.has(`${cardId}:${blockerId}`)) continue
        links.add(`${cardId}:${blockerId}`)
        tx.insert(cardDependency).values({ cardId, blockerId, createdAt: d.createdAt }).run()
      }

      const checklists = data.checklists.filter((cl) => cardIds.has(cl.cardId))
      const checklistIds = fresh(checklists)
      for (const group of groupBy(checklists, (cl) => cl.cardId).values()) {
        const sorted = group.sort(byPosition)
        const keys = orderKeysBetween(null, null, sorted.length)
        sorted.forEach((cl, i) => {
          tx.insert(checklist)
            .values({
              id: checklistIds.get(cl.id)!,
              cardId: cardIds.get(cl.cardId)!,
              name: cl.name,
              position: keys[i]!,
              createdAt: cl.createdAt,
              updatedAt: cl.updatedAt
            })
            .run()
        })
      }
      const items = data.checklistItems.filter((it) => checklistIds.has(it.checklistId))
      for (const group of groupBy(items, (it) => it.checklistId).values()) {
        const sorted = group.sort(byPosition)
        const keys = orderKeysBetween(null, null, sorted.length)
        sorted.forEach((it, i) => {
          tx.insert(checklistItem)
            .values({
              id: newId(),
              checklistId: checklistIds.get(it.checklistId)!,
              text: it.text,
              completed: it.completed,
              position: keys[i]!,
              createdAt: it.createdAt,
              updatedAt: it.updatedAt
            })
            .run()
        })
      }

      for (const c of data.comments) {
        const cardId = cardIds.get(c.cardId)
        if (!cardId) continue
        tx.insert(comment)
          .values({
            id: newId(),
            cardId,
            body: c.body,
            author: c.author === 'ai' ? 'ai' : null,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt
          })
          .run()
      }
      for (const a of keptAttachments) {
        tx.insert(attachment)
          .values({
            id: attachmentIds.get(a.id)!,
            cardId: cardIds.get(a.cardId)!,
            filename: sanitizeAttachmentFilename(a.filename),
            relPath: newRelPath.get(a.relPath)!,
            mime: a.mime,
            size: a.size,
            sourceUrl: a.sourceUrl,
            sourceTitle: a.sourceTitle,
            createdAt: a.createdAt
          })
          .run()
      }
      for (const a of data.activities) {
        tx.insert(activity)
          .values({
            id: newId(),
            boardId,
            cardId: a.cardId ? (cardIds.get(a.cardId) ?? null) : null,
            type: a.type,
            data: a.data ?? null,
            createdAt: a.createdAt
          })
          .run()
      }
    })
  } catch (err) {
    await removeAll(written)
    throw err
  }

  return {
    boardId,
    boardName: data.board.name,
    content: data.content,
    counts: {
      lists: data.lists.length,
      labels: data.labels.length,
      cards: cards.length,
      attachments: keptAttachments.length
    },
    skippedAttachments: attachments.length - keptAttachments.length
  }
}

async function removeAll(dirs: string[]): Promise<void> {
  for (const dir of dirs) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
}
