import { eq } from 'drizzle-orm'
import { type Mutation, passesReadOnlyLock } from '@kanbini/shared'
import type { Db } from './client'
import { cardBoardId, listBoardId } from './crud'
import type { DependencyEdge } from './dependencies'
import { attachment, board, checklist, checklistItem, comment, label } from './schema'

// Which boards' CONTENT a mutation would change, read BEFORE applying it
// (a deleted row can't name its board afterwards). The undo log uses it
// to refuse an undo / redo that would change a board the user locked
// read-only (ADR-0089): the entry is logged under one board, but a
// cross-board card move or copy, a "waiting on" link, or an AI group
// spanning boards reaches another.
//
// What the lock lets through changes nothing here: ticks and view
// settings (passesReadOnlyLock), arranging the home screen (board.move),
// and copying a board (board.duplicate reads the source).

function checklistBoardId(db: Db, checklistId: string): string | null {
  const c = db
    .select({ cardId: checklist.cardId })
    .from(checklist)
    .where(eq(checklist.id, checklistId))
    .get()
  return c ? cardBoardId(db, c.cardId) : null
}

function itemBoardId(db: Db, itemId: string): string | null {
  const it = db
    .select({ cl: checklistItem.checklistId })
    .from(checklistItem)
    .where(eq(checklistItem.id, itemId))
    .get()
  return it ? checklistBoardId(db, it.cl) : null
}

function labelBoardId(db: Db, labelId: string): string | null {
  return (
    db.select({ b: label.boardId }).from(label).where(eq(label.id, labelId)).get()?.b ??
    null
  )
}

function commentBoardId(db: Db, commentId: string): string | null {
  const c = db
    .select({ cardId: comment.cardId })
    .from(comment)
    .where(eq(comment.id, commentId))
    .get()
  return c ? cardBoardId(db, c.cardId) : null
}

function attachmentBoardId(db: Db, attachmentId: string): string | null {
  const a = db
    .select({ cardId: attachment.cardId })
    .from(attachment)
    .where(eq(attachment.id, attachmentId))
    .get()
  return a ? cardBoardId(db, a.cardId) : null
}

/** The boards on the far side of restored "waiting on" links: putting a
 *  link back changes the card at the other end too. */
function edgeBoards(db: Db, edges: readonly DependencyEdge[] | undefined): (string | null)[] {
  return (edges ?? []).flatMap((e) => [cardBoardId(db, e.cardId), cardBoardId(db, e.blockerId)])
}

interface RestoredCard {
  listId: string
  dependencies?: DependencyEdge[]
}

function restoreBoards(db: Db, payload: Record<string, unknown>): (string | null)[] {
  switch (payload.kind) {
    case 'card': {
      const c = payload.card as RestoredCard
      return [listBoardId(db, c.listId), ...edgeBoards(db, c.dependencies)]
    }
    case 'list': {
      const l = payload.list as { boardId: string; cards: RestoredCard[] }
      return [l.boardId, ...l.cards.flatMap((c) => edgeBoards(db, c.dependencies))]
    }
    case 'board': {
      const b = payload.board as { id: string; lists: { cards: RestoredCard[] }[] }
      return [
        b.id,
        ...b.lists.flatMap((l) => l.cards.flatMap((c) => edgeBoards(db, c.dependencies)))
      ]
    }
    case 'checklist':
      return [cardBoardId(db, (payload.checklist as { cardId: string }).cardId)]
    case 'checklistItem':
      return [checklistBoardId(db, (payload.item as { checklistId: string }).checklistId)]
    case 'comment':
      return [cardBoardId(db, (payload.comment as { cardId: string }).cardId)]
    case 'label':
      return [(payload.label as { boardId: string }).boardId]
    case 'attachment':
      return [cardBoardId(db, (payload.attachment as { cardId: string }).cardId)]
    default:
      return []
  }
}

function changedBoards(db: Db, m: Mutation): (string | null)[] {
  if (passesReadOnlyLock(m)) return []
  switch (m.type) {
    case 'project.create':
    case 'project.update':
    case 'board.create':
    case 'board.move':
    case 'board.duplicate':
      return []
    case 'project.delete':
      return db
        .select({ id: board.id })
        .from(board)
        .where(eq(board.projectId, m.id))
        .all()
        .map((b) => b.id)
    case 'board.update':
    case 'board.delete':
      return [m.id]
    case 'list.create':
      return [m.boardId]
    case 'list.update':
    case 'list.delete':
    case 'list.move':
      return [listBoardId(db, m.id)]
    case 'card.create':
      return [listBoardId(db, m.listId)]
    case 'card.copy':
      return [listBoardId(db, m.toListId)]
    case 'card.update':
    case 'card.delete':
    case 'card.setLabels':
      return [cardBoardId(db, m.id)]
    case 'card.move':
    case 'card.spawnNext':
      return [cardBoardId(db, m.id), listBoardId(db, m.toListId)]
    case 'card.unspawnNext':
      return [cardBoardId(db, m.id), cardBoardId(db, m.copyId)]
    case 'card.addBlocker':
    case 'card.removeBlocker':
      return [cardBoardId(db, m.id), cardBoardId(db, m.blockerId)]
    case 'label.create':
      return [m.boardId]
    case 'label.update':
    case 'label.delete':
      return [labelBoardId(db, m.id)]
    case 'checklist.create':
    case 'comment.create':
      return [cardBoardId(db, m.cardId)]
    case 'checklist.update':
    case 'checklist.delete':
      return [checklistBoardId(db, m.id)]
    case 'checklistItem.create':
      return [checklistBoardId(db, m.checklistId)]
    case 'checklistItem.update':
    case 'checklistItem.delete':
      return [itemBoardId(db, m.id)]
    case 'checklistItem.move':
      return [itemBoardId(db, m.id), checklistBoardId(db, m.toChecklistId)]
    case 'comment.update':
    case 'comment.delete':
      return [commentBoardId(db, m.id)]
    case 'attachment.delete':
      return [attachmentBoardId(db, m.id)]
    case 'restore':
      return restoreBoards(db, m.payload)
  }
}

/** The boards whose content applying `m` would change, deduplicated. */
export function boardsChangedBy(db: Db, m: Mutation): string[] {
  return [...new Set(changedBoards(db, m).filter((b): b is string => b != null))]
}
