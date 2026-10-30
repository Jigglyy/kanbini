import { asc, eq, gt, inArray } from 'drizzle-orm'
import { type Mutation, type MutationResult, newId } from '@kanbini/shared'
import type { Db } from './client'
import { attachment, checklist, checklistItem, comment, undoLog } from './schema'

// Changes that come in over the control channel: the AI (through the MCP
// server) and local scripts. Two things set them apart from the user's own
// edits:
//
// - Undo: everything the AI changes on a board since the user last did
//   something there (or since AI_UNDO_GROUP_GAP_MS of AI silence) is ONE
//   undo group, so a single Ctrl+Z takes back the AI's whole run however
//   it sent the changes. The channel marks the log before a write
//   (`markAiWrite`) and folds the entries recorded since into the board's
//   ongoing AI group afterwards (`joinAiUndoGroup`). Groups are per board,
//   like undo itself (undoOne scopes to the open board).
// - The board view: the change event names the cards touched
//   (`touchedCardIds`) so the renderer can glow them.

/** AI undo groups' ids start with this, so the next AI write can tell an
 *  ongoing AI group from a user's bulk gesture without another column. */
export const AI_UNDO_GROUP_PREFIX = 'ai:'

/** This long without an AI change on a board starts a new group there. */
export const AI_UNDO_GROUP_GAP_MS = 5 * 60_000

/** A run this long starts a new group. The log trim never splits a group,
 *  so without a ceiling an AI working for hours would keep every entry. */
export const AI_UNDO_GROUP_MAX = 500

export const isAiUndoGroup = (groupId: string | null | undefined): boolean =>
  groupId?.startsWith(AI_UNDO_GROUP_PREFIX) ?? false

interface LogRow {
  groupId: string | null
  status: 'undoable' | 'undone'
  createdAt: number
}

/** The undo log as it was before an AI write. */
export interface AiWriteMark {
  /** Newest entry id (UUIDv7, so later entries sort after it). */
  lastId: string | null
  /** Each board's newest entry. Read now because the write itself clears
   *  the redo tail: an undo the user just made would be gone by then, and
   *  it has to count as the user acting on that board. */
  newestByBoard: Map<string | null, LogRow>
}

export function markAiWrite(db: Db): AiWriteMark {
  // The log is capped (MAX_UNDO_LOG_SIZE, groups kept whole), so reading
  // it all is cheap.
  const rows = db
    .select({
      id: undoLog.id,
      boardId: undoLog.boardId,
      groupId: undoLog.groupId,
      status: undoLog.status,
      createdAt: undoLog.createdAt
    })
    .from(undoLog)
    .orderBy(asc(undoLog.id))
    .all()
  const newestByBoard = new Map<string | null, LogRow>()
  for (const r of rows) newestByBoard.set(r.boardId, r)
  return { lastId: rows.at(-1)?.id ?? null, newestByBoard }
}

/** Fold the entries recorded since `mark` into the AI's ongoing group on
 *  their board (the board of the newest one - a move to another board is
 *  logged under the board it left), or start a new group. The ongoing
 *  group continues only when that board's newest entry before the write
 *  was an undoable AI entry from within the gap: a user edit there, or an
 *  undo, starts a new one. Returns the group id, or null when the write
 *  recorded nothing. */
export function joinAiUndoGroup(
  db: Db,
  mark: AiWriteMark,
  now: number = Date.now()
): string | null {
  const added = db
    .select({ id: undoLog.id, boardId: undoLog.boardId })
    .from(undoLog)
    .where(mark.lastId === null ? undefined : gt(undoLog.id, mark.lastId))
    .orderBy(asc(undoLog.id))
    .all()
  if (added.length === 0) return null
  const prev = mark.newestByBoard.get(added.at(-1)!.boardId)
  const ongoing =
    prev &&
    prev.status === 'undoable' &&
    isAiUndoGroup(prev.groupId) &&
    now - prev.createdAt <= AI_UNDO_GROUP_GAP_MS &&
    db
      .select({ id: undoLog.id })
      .from(undoLog)
      .where(eq(undoLog.groupId, prev.groupId!))
      .all().length +
      added.length <=
      AI_UNDO_GROUP_MAX
  const groupId = ongoing ? prev.groupId! : AI_UNDO_GROUP_PREFIX + newId()
  db.update(undoLog)
    .set({ groupId })
    .where(inArray(undoLog.id, added.map((r) => r.id)))
    .run()
  return groupId
}

function checklistCard(db: Db, checklistId: string): string | undefined {
  return db
    .select({ c: checklist.cardId })
    .from(checklist)
    .where(eq(checklist.id, checklistId))
    .get()?.c
}

function itemCard(db: Db, itemId: string): string | undefined {
  const cl = db
    .select({ cl: checklistItem.checklistId })
    .from(checklistItem)
    .where(eq(checklistItem.id, itemId))
    .get()?.cl
  return cl ? checklistCard(db, cl) : undefined
}

/** The cards a mutation changes, read BEFORE applying it (a deleted
 *  checklist item or comment can't name its card afterwards). Creates
 *  pass `result` after applying for the new card's id. List, board and
 *  label changes touch no card; a deleted card has nothing left to show. */
export function touchedCardIds(db: Db, m: Mutation, result?: MutationResult): string[] {
  const one = (id: string | undefined): string[] => (id ? [id] : [])
  switch (m.type) {
    case 'card.create':
    case 'card.copy':
      return one(result?.id)
    case 'card.update':
    case 'card.move':
    case 'card.setLabels':
    case 'card.addBlocker':
    case 'card.removeBlocker':
      return [m.id]
    case 'checklist.create':
    case 'comment.create':
      return [m.cardId]
    case 'checklist.update':
    case 'checklist.delete':
      return one(checklistCard(db, m.id))
    case 'checklistItem.create':
      return one(checklistCard(db, m.checklistId))
    case 'checklistItem.update':
    case 'checklistItem.delete':
      return one(itemCard(db, m.id))
    case 'checklistItem.move':
      return [...new Set([...one(itemCard(db, m.id)), ...one(checklistCard(db, m.toChecklistId))])]
    case 'comment.update':
    case 'comment.delete':
      return one(
        db.select({ c: comment.cardId }).from(comment).where(eq(comment.id, m.id)).get()?.c
      )
    case 'attachment.delete':
      return one(
        db.select({ c: attachment.cardId }).from(attachment).where(eq(attachment.id, m.id)).get()
          ?.c
      )
    default:
      return []
  }
}
