import { asc, eq, inArray } from 'drizzle-orm'
import { type Mutation, type MutationResult, newId } from '@kanbini/shared'
import type { Db } from './client'
import { cardArrivalKey, listBoardId, logActivity } from './crud'
import {
  attachment,
  card,
  cardLabel,
  checklist,
  checklistItem,
  label
} from './schema'

// Moving and copying cards between boards. Labels belong to one board, so
// a card that lands on another board keeps its labels BY NAME: each one is
// matched to the target board's label with the same name (trimmed, any
// case), and a label the target board doesn't have yet is created there
// with the same name and colour. Nothing the card was tagged with is lost.
//
// The undo recorder creates those missing labels itself, as separate
// `label.create` entries in the move's or copy's undo group
// (`missingLabels` tells it which), so one Ctrl+Z also removes the labels
// the move added. Outside the recorder (a raw applyMutation) they're
// created inline by `labelsOnBoard`.

const nameKey = (name: string): string => name.trim().toLowerCase()

interface CardLabelRow {
  id: string
  boardId: string
  name: string
  color: string
}

function cardLabels(db: Db, cardId: string): CardLabelRow[] {
  return db
    .select({ id: label.id, boardId: label.boardId, name: label.name, color: label.color })
    .from(cardLabel)
    .innerJoin(label, eq(label.id, cardLabel.labelId))
    .where(eq(cardLabel.cardId, cardId))
    .orderBy(asc(label.id))
    .all()
}

/** The board's labels by name (the oldest wins when two share a name). */
function labelsByName(db: Db, boardId: string): Map<string, string> {
  const byName = new Map<string, string>()
  for (const l of db
    .select({ id: label.id, name: label.name })
    .from(label)
    .where(eq(label.boardId, boardId))
    .orderBy(asc(label.id))
    .all()) {
    if (!byName.has(nameKey(l.name))) byName.set(nameKey(l.name), l.id)
  }
  return byName
}

/** The card's labels that `boardId` has no label of the same name for,
 *  one per name, oldest first. Empty when the card is already there. */
export function missingLabels(
  db: Db,
  cardId: string,
  boardId: string
): { name: string; color: string }[] {
  const byName = labelsByName(db, boardId)
  const missing = new Map<string, { name: string; color: string }>()
  for (const l of cardLabels(db, cardId)) {
    if (l.boardId === boardId || byName.has(nameKey(l.name))) continue
    if (!missing.has(nameKey(l.name))) {
      missing.set(nameKey(l.name), { name: l.name, color: l.color })
    }
  }
  return [...missing.values()]
}

/** `boardId`'s label ids for the card's labels, creating the ones the
 *  board doesn't have. Deduplicated (two labels with one name map to the
 *  same target label). */
export function labelsOnBoard(db: Db, cardId: string, boardId: string): string[] {
  const byName = labelsByName(db, boardId)
  const out: string[] = []
  for (const l of cardLabels(db, cardId)) {
    let id = l.boardId === boardId ? l.id : byName.get(nameKey(l.name))
    if (id === undefined) {
      id = newId()
      db.insert(label).values({ id, boardId, name: l.name, color: l.color }).run()
      byName.set(nameKey(l.name), id)
    }
    if (!out.includes(id)) out.push(id)
  }
  return out
}

type CardCopy = Extract<Mutation, { type: 'card.copy' }>

/** `card.copy`: a new card in `toListId` with the source card's content
 *  (see the mutation's comment in @kanbini/shared for what comes along).
 *  Attachments are new rows that point at the SAME files, so nothing is
 *  duplicated on disk; deleting one card's attachment leaves a file other
 *  rows still use (deleteAttachmentWithFile), and the GC sweep counts
 *  every row's folder as in use. */
export function copyCard(db: Db, m: CardCopy): MutationResult {
  const src = db.select().from(card).where(eq(card.id, m.id)).get()
  if (!src) throw new Error(`card ${m.id} not found`)
  const boardId = listBoardId(db, m.toListId)
  if (boardId === null) throw new Error(`list ${m.toListId} not found`)
  const id = m.newId ?? newId()
  const labelIds = labelsOnBoard(db, m.id, boardId)

  const atts = db.select().from(attachment).where(eq(attachment.cardId, m.id)).all()
  const attachmentIds = new Map(atts.map((a) => [a.id, newId()]))

  db.insert(card)
    .values({
      id,
      // Undefined -> the DB trigger hands out the next number; a redo
      // passes the original one back.
      number: m.number,
      listId: m.toListId,
      title: m.title ?? src.title,
      description: src.description,
      position: cardArrivalKey(db, m.toListId, m.beforeId, m.afterId),
      dueAt: src.dueAt,
      completed: src.completed,
      priority: src.priority,
      collapsed: src.collapsed,
      repeat: src.repeat
    })
    .run()
  if (labelIds.length > 0) {
    db.insert(cardLabel)
      .values(labelIds.map((labelId) => ({ cardId: id, labelId })))
      .run()
  }

  const lists = db
    .select()
    .from(checklist)
    .where(eq(checklist.cardId, m.id))
    .orderBy(asc(checklist.position))
    .all()
  const items =
    lists.length > 0
      ? db
          .select()
          .from(checklistItem)
          .where(inArray(checklistItem.checklistId, lists.map((l) => l.id)))
          .all()
      : []
  for (const cl of lists) {
    const clId = newId()
    db.insert(checklist)
      .values({ id: clId, cardId: id, name: cl.name, position: cl.position })
      .run()
    const mine = items.filter((it) => it.checklistId === cl.id)
    if (mine.length > 0) {
      db.insert(checklistItem)
        .values(
          mine.map((it) => ({
            id: newId(),
            checklistId: clId,
            text: it.text,
            position: it.position,
            completed: it.completed
          }))
        )
        .run()
    }
  }

  if (atts.length > 0) {
    db.insert(attachment)
      .values(
        atts.map((a) => ({
          id: attachmentIds.get(a.id)!,
          cardId: id,
          filename: a.filename,
          relPath: a.relPath,
          mime: a.mime,
          size: a.size,
          sourceUrl: a.sourceUrl,
          sourceTitle: a.sourceTitle
        }))
      )
      .run()
    const cover = src.coverAttachmentId ? attachmentIds.get(src.coverAttachmentId) : undefined
    if (cover) {
      db.update(card).set({ coverAttachmentId: cover }).where(eq(card.id, id)).run()
    }
  }

  logActivity(db, {
    boardId,
    cardId: id,
    type: 'copied',
    data: { fromCardId: m.id, fromTitle: src.title, fromNumber: src.number }
  })
  return { id, boardId }
}
