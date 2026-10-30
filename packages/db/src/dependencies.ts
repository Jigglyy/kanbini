import { and, asc, eq, inArray, or, sql, type SQLWrapper } from 'drizzle-orm'
import type { CardRef } from '@kanbini/shared'
import type { Db } from './client'
import { board, card, cardDependency, list } from './schema'

// "Blocked by" links between cards (card_dependency). A row (cardId,
// blockerId) means cardId waits on blockerId. Links may cross boards.
// This module owns the rules (no self-links, no cycles), the batched
// reads the board / card views use, and the edge capture + replay the
// undo snapshots use. applyMutation's `card.addBlocker` /
// `card.removeBlocker` arms call into it.

/** One stored link, as captured in undo snapshots and exports. */
export interface DependencyEdge {
  cardId: string
  blockerId: string
  createdAt: number
}

/** Would making `cardId` wait on `blockerId` close a loop? True when
 *  `blockerId` already (directly or transitively) waits on `cardId`. */
export function wouldCreateCycle(
  db: Db,
  cardId: string,
  blockerId: string
): boolean {
  if (cardId === blockerId) return true
  const row = db.get<{ hit: number } | undefined>(sql`
    WITH RECURSIVE waits_on(id) AS (
      SELECT blocker_id FROM card_dependency WHERE card_id = ${blockerId}
      UNION
      SELECT d.blocker_id FROM card_dependency d
      INNER JOIN waits_on w ON d.card_id = w.id
    )
    SELECT 1 AS hit FROM waits_on WHERE id = ${cardId} LIMIT 1
  `)
  return row !== undefined
}

export function hasBlocker(db: Db, cardId: string, blockerId: string): boolean {
  return (
    db
      .select({ c: cardDependency.cardId })
      .from(cardDependency)
      .where(
        and(
          eq(cardDependency.cardId, cardId),
          eq(cardDependency.blockerId, blockerId)
        )
      )
      .get() !== undefined
  )
}

/** Make `cardId` wait on `blockerId`. Returns false when the link
 *  already exists (a no-op). Throws for a missing card, a self-link, or
 *  a link that would close a cycle, before anything is written. */
export function addBlocker(db: Db, cardId: string, blockerId: string): boolean {
  if (cardId === blockerId) {
    throw new Error('a card cannot wait on itself')
  }
  const found = db
    .select({ id: card.id })
    .from(card)
    .where(inArray(card.id, [cardId, blockerId]))
    .all()
    .map((r) => r.id)
  if (!found.includes(cardId)) throw new Error(`card ${cardId} not found`)
  if (!found.includes(blockerId)) throw new Error(`card ${blockerId} not found`)
  if (hasBlocker(db, cardId, blockerId)) return false
  if (wouldCreateCycle(db, cardId, blockerId)) {
    throw new Error(
      `card ${blockerId} already waits on card ${cardId}, directly or ` +
        'through other cards, so this link would make a loop'
    )
  }
  // Millisecond stamp (the column default is whole seconds) so links
  // made in quick succession keep the order they were added in.
  db.insert(cardDependency).values({ cardId, blockerId, createdAt: Date.now() }).run()
  return true
}

/** Drop the link. Returns false when there was none. */
export function removeBlocker(
  db: Db,
  cardId: string,
  blockerId: string
): boolean {
  if (!hasBlocker(db, cardId, blockerId)) return false
  db.delete(cardDependency)
    .where(
      and(
        eq(cardDependency.cardId, cardId),
        eq(cardDependency.blockerId, blockerId)
      )
    )
    .run()
  return true
}

/** Every link touching `cardId`, either direction. For undo snapshots:
 *  deleting the card cascades these away. */
export function dependencyEdgesOf(db: Db, cardId: string): DependencyEdge[] {
  return db
    .select()
    .from(cardDependency)
    .where(
      or(eq(cardDependency.cardId, cardId), eq(cardDependency.blockerId, cardId))
    )
    .orderBy(
      asc(cardDependency.createdAt),
      asc(cardDependency.cardId),
      asc(cardDependency.blockerId)
    )
    .all()
}

/** Re-insert captured links whose two cards both exist (either end may
 *  have been deleted since the snapshot). Duplicates are skipped, so
 *  replaying a list or board whose cards share links is safe. */
export function restoreDependencyEdges(db: Db, edges: readonly DependencyEdge[]): void {
  if (edges.length === 0) return
  const ids = [...new Set(edges.flatMap((e) => [e.cardId, e.blockerId]))]
  const present = new Set(
    db
      .select({ id: card.id })
      .from(card)
      .where(inArray(card.id, ids))
      .all()
      .map((r) => r.id)
  )
  const keep = edges.filter((e) => present.has(e.cardId) && present.has(e.blockerId))
  if (keep.length === 0) return
  db.insert(cardDependency).values(keep).onConflictDoNothing().run()
}

/** Title + board + list context for the far end of each link, batched.
 *  `scope` limits which near-end cards to look at: a board's card-id
 *  subquery for the board view, or one id for the card view. Ordered
 *  oldest link first, far-end id as tiebreak (the headless reader
 *  mirrors this). */
export function dependencyRefs(
  db: Db,
  scope: SQLWrapper | string[]
): {
  blockedBy: Map<string, CardRef[]>
  blocking: Map<string, CardRef[]>
} {
  const refCols = {
    cardId: card.id,
    number: sql<number>`coalesce(${card.number}, 0)`,
    title: card.title,
    completed: card.completed,
    archived: card.archived,
    boardId: board.id,
    boardName: board.name,
    listName: list.name
  }

  const blockedByRows = db
    .select({ near: cardDependency.cardId, ...refCols })
    .from(cardDependency)
    .innerJoin(card, eq(card.id, cardDependency.blockerId))
    .innerJoin(list, eq(list.id, card.listId))
    .innerJoin(board, eq(board.id, list.boardId))
    .where(inArray(cardDependency.cardId, scope))
    .orderBy(
      asc(cardDependency.cardId),
      asc(cardDependency.createdAt),
      asc(cardDependency.blockerId)
    )
    .all()

  const blockingRows = db
    .select({ near: cardDependency.blockerId, ...refCols })
    .from(cardDependency)
    .innerJoin(card, eq(card.id, cardDependency.cardId))
    .innerJoin(list, eq(list.id, card.listId))
    .innerJoin(board, eq(board.id, list.boardId))
    .where(inArray(cardDependency.blockerId, scope))
    .orderBy(
      asc(cardDependency.blockerId),
      asc(cardDependency.createdAt),
      asc(cardDependency.cardId)
    )
    .all()

  const group = (
    rows: Array<{ near: string } & CardRef>
  ): Map<string, CardRef[]> => {
    const out = new Map<string, CardRef[]>()
    for (const { near, ...ref } of rows) {
      const arr = out.get(near)
      if (arr) arr.push(ref)
      else out.set(near, [ref])
    }
    return out
  }

  return { blockedBy: group(blockedByRows), blocking: group(blockingRows) }
}

/** A card's title, for activity rows that name the other end. */
export function cardTitle(db: Db, id: string): string | null {
  return db.select({ title: card.title }).from(card).where(eq(card.id, id)).get()?.title ?? null
}
