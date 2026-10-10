import { and, asc, eq, inArray } from 'drizzle-orm'
import {
  type CardRepeat,
  type Mutation,
  type MutationResult,
  newId,
  nextDueAt,
  zCardRepeat
} from '@kanbini/shared'
import type { Db } from './client'
import { appendCardKey, cardBoardId, listBoardId, logActivity } from './crud'
import { card, cardLabel, checklist, checklistItem, label, list } from './schema'

// Repeating cards. Completing a card that has a repeat rule creates the
// next occurrence: a fresh copy due one repeat later, in the list the
// card was worked in, carrying the rule forward. The finished card stays
// where it is as the record of that occurrence, with no rule of its own,
// so reopening and re-completing it can't spawn a second copy.
//
// The spawn is NOT a side effect inside applyMutation. The undo recorder
// (applyMutationRecorded) asks `repeatSpawnPlan` before applying a
// mutation, and when that mutation really completed a repeating card it
// records a separate `card.spawnNext` in the SAME undo group. So one
// Ctrl+Z removes the copy, puts the rule back and reopens the card, and
// a redo replays the same spawn with the same copy id. Undo and redo
// apply entries silently (straight to applyMutation), so they never
// trigger a fresh spawn.

/** Soft-narrow a stored rule; anything unrecognised reads as no rule. */
export function parseRepeat(value: unknown): CardRepeat | null {
  if (value == null) return null
  const parsed = zCardRepeat.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** If applying `m` would complete a repeating card, where its next
 *  occurrence goes. Read BEFORE `m` is applied. */
export function repeatSpawnPlan(
  db: Db,
  m: Mutation
): { cardId: string; toListId: string } | null {
  if (m.type === 'card.update' && m.patch.completed === true) {
    const c = db
      .select({ listId: card.listId, completed: card.completed, repeat: card.repeat })
      .from(card)
      .where(eq(card.id, m.id))
      .get()
    if (!c || c.completed || !parseRepeat(c.repeat)) return null
    // A patch that also clears or replaces the rule decides for itself:
    // clearing means "done, and stop repeating".
    if (m.patch.repeat === null) return null
    return { cardId: m.id, toListId: c.listId }
  }
  if (m.type === 'card.move') {
    const c = db
      .select({ listId: card.listId, completed: card.completed, repeat: card.repeat })
      .from(card)
      .where(eq(card.id, m.id))
      .get()
    if (!c || c.completed || c.listId === m.toListId || !parseRepeat(c.repeat)) {
      return null
    }
    const target = db
      .select({ onEnter: list.onEnter })
      .from(list)
      .where(eq(list.id, m.toListId))
      .get()
    const rule = target?.onEnter as { kind?: unknown } | null | undefined
    if (rule?.kind !== 'complete') return null
    // Dropped into a "Done" list: the next one belongs where it came from.
    return { cardId: m.id, toListId: c.listId }
  }
  return null
}

/** `card.spawnNext`: create the next occurrence of `id` as `copyId` in
 *  `toListId` (falling back to the card's own list if that list is
 *  gone) and move the repeat rule onto it. A no-op when the card is
 *  gone or no longer repeats. `copyNumber` (a redo) reuses the copy's
 *  original card number; omitted, the DB hands out the next one. */
export function spawnNextOccurrence(
  db: Db,
  id: string,
  copyId: string,
  toListId: string,
  { copyNumber, now = Date.now() }: { copyNumber?: number; now?: number } = {}
): MutationResult {
  const orig = db.select().from(card).where(eq(card.id, id)).get()
  const rule = orig ? parseRepeat(orig.repeat) : null
  if (!orig || !rule) return { id, boardId: orig ? cardBoardId(db, id) : null }

  const targetList = db.select({ id: list.id }).from(list).where(eq(list.id, toListId)).get()
    ? toListId
    : orig.listId
  const boardId = listBoardId(db, targetList)
  const dueAt = nextDueAt(orig.dueAt, rule, now)

  db.insert(card)
    .values({
      id: copyId,
      number: copyNumber,
      listId: targetList,
      title: orig.title,
      description: orig.description,
      position: appendCardKey(db, targetList),
      dueAt,
      priority: orig.priority,
      collapsed: orig.collapsed,
      repeat: rule
    })
    .run()

  // Labels are board-scoped: keep the ones that belong to the copy's board.
  const labelIds = db
    .select({ id: cardLabel.labelId })
    .from(cardLabel)
    .innerJoin(label, eq(label.id, cardLabel.labelId))
    .where(and(eq(cardLabel.cardId, id), eq(label.boardId, boardId ?? '')))
    .all()
    .map((r) => r.id)
  if (labelIds.length > 0) {
    db.insert(cardLabel)
      .values(labelIds.map((labelId) => ({ cardId: copyId, labelId })))
      .run()
  }

  // Checklists come along with every item unticked: it's a new round.
  const lists = db
    .select()
    .from(checklist)
    .where(eq(checklist.cardId, id))
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
      .values({ id: clId, cardId: copyId, name: cl.name, position: cl.position })
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
            completed: false
          }))
        )
        .run()
    }
  }

  // The finished card keeps no rule, so it can't spawn twice.
  db.update(card).set({ repeat: null }).where(eq(card.id, id)).run()

  logActivity(db, {
    boardId: cardBoardId(db, id),
    cardId: id,
    type: 'repeat-next',
    data: { cardId: copyId, dueAt }
  })
  logActivity(db, {
    boardId,
    cardId: copyId,
    type: 'repeat-created',
    data: { fromCardId: id, repeat: rule }
  })
  return { id: copyId, boardId }
}

/** `card.unspawnNext` (undo of spawnNext): drop the copy and give the
 *  rule back to the original. */
export function unspawnNextOccurrence(
  db: Db,
  id: string,
  copyId: string,
  rule: CardRepeat
): MutationResult {
  const boardId = cardBoardId(db, id)
  db.delete(card).where(eq(card.id, copyId)).run()
  db.update(card).set({ repeat: rule }).where(eq(card.id, id)).run()
  return { id, boardId }
}
