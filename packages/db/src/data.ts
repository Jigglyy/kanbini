import { asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import {
  type BoardBackground,
  type BoardSummary,
  type BoardView,
  type CardPriority,
  type ListOnEnterRule,
  type ListSortMode,
  type SwimlaneMode,
  firstOrderKey,
  newId,
  orderKeysBetween,
  zBoardBackground,
  zCardPriority,
  zListOnEnterRule,
  zListSortMode,
  zSwimlaneMode
} from '@kanbini/shared'
import type { Db } from './client'
import {
  activity,
  attachment,
  board,
  card,
  cardLabel,
  checklist,
  checklistItem,
  comment,
  label,
  list,
  project
} from './schema'

/** Recent activity rows for the card-detail feed (newest first).
 *  Capped to keep the payload small; older history lives in the table
 *  for future global-history / export. */
const ACTIVITY_FEED_LIMIT = 30

/** Narrow `board.background` (drizzle gives us `unknown` via the
 *  JSON-mode column). Returns null both when the column is null AND
 *  when the stored shape no longer parses - better to drop a broken
 *  background than to throw out the whole board view. ADR-0034. */
function parseBackground(value: unknown): BoardBackground | null {
  if (value == null) return null
  const parsed = zBoardBackground.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** Narrow the stored priority text to the typed enum the renderer
 *  expects. Unknown values (older builds, hand-edited DB) parse to
 *  null - the renderer renders an unprioritised card, which is the
 *  safer fail-mode than throwing out the card. ADR-0037. */
function parsePriority(value: string | null): CardPriority | null {
  if (value == null) return null
  const parsed = zCardPriority.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** Soft-narrow the stored swimlane mode (ADR-0037 slice 2). Unknown
 *  values (older DB, future modes not yet in this build) parse to
 *  null - the renderer renders the flat layout, the safer fallback. */
function parseSwimlaneMode(value: string | null): SwimlaneMode | null {
  if (value == null) return null
  const parsed = zSwimlaneMode.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** Soft-narrow the stored on-enter rule (ADR-0041). Unknown shapes
 *  (future kinds, hand-edited DB) parse to null - the renderer
 *  shows "None" in the editor, the db skips the rule on card.move.
 *  Storage is JSON-mode so drizzle has already parsed the column. */
function parseOnEnter(value: unknown): ListOnEnterRule | null {
  if (value == null) return null
  const parsed = zListOnEnterRule.safeParse(value)
  return parsed.success ? parsed.data : null
}

// M0 read path + first-run seed. All access funnels through the main
// process (DESIGN §5 single-writer); write/CRUD helpers land in M1.

/** Insert a sample project/board/lists/cards - only if the DB is empty. */
export function seedSampleData(db: Db): void {
  const already = db.select({ id: project.id }).from(project).limit(1).all()
  if (already.length > 0) return

  const projectId = newId()
  const boardId = newId()
  db.insert(project).values({ id: projectId, name: 'Sample Project' }).run()
  db.insert(board)
    .values({
      id: boardId,
      projectId,
      name: 'Welcome Board',
      position: firstOrderKey()
    })
    .run()

  const labelIds = {
    feature: newId(),
    bug: newId()
  }
  db.insert(label)
    .values([
      // Matches the renderer accent palette (apps/renderer/src/lib/palette.ts)
      { id: labelIds.feature, boardId, name: 'Feature', color: 'oklch(0.62 0.15 250)' },
      { id: labelIds.bug, boardId, name: 'Bug', color: 'oklch(0.62 0.17 25)' }
    ])
    .run()

  const columns: Array<{ name: string; cards: Array<[string, string[]]> }> = [
    {
      name: 'To Do',
      cards: [
        ['Drag a card to another list', [labelIds.feature]],
        ['Click the checkbox to complete me', []],
        ['Hover for the delete + label buttons', [labelIds.bug]]
      ]
    },
    { name: 'In Progress', cards: [['Try the label filter above', []]] },
    { name: 'Done', cards: [['Scaffold the stack (M0)', []]] }
  ]
  const listKeys = orderKeysBetween(null, null, columns.length)

  columns.forEach((col, i) => {
    const listId = newId()
    db.insert(list)
      .values({ id: listId, boardId, name: col.name, position: listKeys[i]! })
      .run()
    const cardKeys = orderKeysBetween(null, null, col.cards.length)
    col.cards.forEach(([title, cardLabelIds], j) => {
      const cardId = newId()
      db.insert(card)
        .values({
          id: cardId,
          listId,
          title,
          position: cardKeys[j]!,
          completed: i === columns.length - 1
        })
        .run()
      if (cardLabelIds.length > 0) {
        db.insert(cardLabel)
          .values(cardLabelIds.map((lid) => ({ cardId, labelId: lid })))
          .run()
      }
      // Give the first "To Do" card a sample checklist so opening the
      // card detail panel has something to show.
      if (i === 0 && j === 0) {
        const checklistId = newId()
        db.insert(checklist)
          .values({
            id: checklistId,
            cardId,
            name: 'Steps',
            position: firstOrderKey()
          })
          .run()
        const items: Array<[string, boolean]> = [
          ['Open this card to see its detail', true],
          ['Edit the description in the editor', false],
          ['Add a sub-item below', false]
        ]
        const itemKeys = orderKeysBetween(null, null, items.length)
        items.forEach(([text, done], k) => {
          db.insert(checklistItem)
            .values({
              id: newId(),
              checklistId,
              text,
              completed: done,
              position: itemKeys[k]!
            })
            .run()
        })
      }
    })
  })
}

/** Flat list of every board for the home picker (M4-G). Ordered by
 *  `pinned desc, position asc` (M4-G+: pinned boards float to the top
 *  so a single canonical order survives optimistic DnD reorders in the
 *  renderer cache - no client-side re-sort fighting the drag). Archived
 *  rows included so the renderer can decide whether to hide them.
 *  `updatedAt` blends the board row's own timestamp with the most
 *  recent activity-log entry for that board, so "recently used"
 *  reflects card edits - not just board renames. */
export function listBoards(db: Db): BoardSummary[] {
  const rows = db
    .select()
    .from(board)
    .orderBy(desc(board.pinned), asc(board.position))
    .all()

  // Counts + recency are computed in three GROUP BY sweeps over the
  // whole table set, not per-board: this runs on the home screen AND
  // re-runs on every mutation (the boardsList query invalidates so the
  // home counts stay live), so the old 3-queries-per-board shape was
  // O(boards) on a hot path. These three are O(1) in board count.
  const listCounts = new Map(
    db
      .select({ boardId: list.boardId, c: sql<number>`count(*)` })
      .from(list)
      .where(eq(list.closed, false))
      .groupBy(list.boardId)
      .all()
      .map((r) => [r.boardId, r.c])
  )
  const cardCounts = new Map(
    db
      .select({ boardId: list.boardId, c: sql<number>`count(*)` })
      .from(card)
      .innerJoin(list, eq(card.listId, list.id))
      .where(eq(card.archived, false))
      .groupBy(list.boardId)
      .all()
      .map((r) => [r.boardId, r.c])
  )
  const latestActivity = new Map(
    db
      .select({ boardId: activity.boardId, a: sql<number>`max(created_at)` })
      .from(activity)
      .groupBy(activity.boardId)
      .all()
      .map((r) => [r.boardId, r.a ?? 0])
  )

  return rows.map((b) => ({
    id: b.id,
    projectId: b.projectId,
    name: b.name,
    description: b.description,
    color: b.color,
    background: parseBackground(b.background),
    archived: b.archived,
    pinned: b.pinned,
    position: b.position,
    listCount: listCounts.get(b.id) ?? 0,
    cardCount: cardCounts.get(b.id) ?? 0,
    createdAt: b.createdAt,
    updatedAt: Math.max(b.updatedAt, latestActivity.get(b.id) ?? 0)
  }))
}

/** Nested view of a board (first board if no id). null if none. */
/** Soft-narrow a stored list.sort_mode to a known mode (null = manual).
 *  An unrecognised value (an older row, or a mode shipped by a newer
 *  build) degrades to manual rather than throwing. Exported so the
 *  write side (crud.ts flip-to-manual snapshot) freezes cards in the
 *  exact order they were displayed under the previous mode. */
export function parseListSortMode(s: string | null): ListSortMode | null {
  const r = zListSortMode.safeParse(s)
  return r.success ? r.data : null
}

/** ORDER BY clause for a list's cards under the given sort mode. Manual
 *  (null) keeps the fractional-index order; every computed mode ends in
 *  a stable tiebreaker so equal keys never reorder between reads. The
 *  headless MCP reader (apps/mcp/src/headless.ts `compareCards`) mirrors
 *  this exactly - keep the two in lockstep or the drift test fails.
 *  Exported for the crud.ts flip-to-manual snapshot (same ordering). */
export function cardOrdering(mode: ListSortMode | null): SQL[] {
  switch (mode) {
    case 'created-desc':
      return [desc(card.createdAt), desc(card.id)]
    case 'created-asc':
      return [asc(card.createdAt), asc(card.id)]
    case 'added-desc':
      return [desc(card.listAddedAt), desc(card.id)]
    case 'added-asc':
      return [asc(card.listAddedAt), asc(card.id)]
    case 'due-asc':
      // Soonest due first; cards with no due date sink to the bottom.
      return [asc(sql`${card.dueAt} is null`), asc(card.dueAt), asc(card.id)]
    case 'title-asc':
      return [asc(sql`lower(${card.title})`), asc(card.id)]
    case 'title-desc':
      return [desc(sql`lower(${card.title})`), desc(card.id)]
    case 'priority-desc':
      // urgent -> high -> medium -> low -> unprioritised; ties keep the
      // manual order within each priority bucket.
      return [
        asc(
          sql`case ${card.priority} when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 when 'low' then 3 else 4 end`
        ),
        asc(card.position)
      ]
    default:
      return [asc(card.position)]
  }
}

/** Parse a raw activity `data` TEXT column (the window-function query
 *  bypasses drizzle's JSON-mode mapping). Returns null for an absent or
 *  malformed value so a single bad row never throws out the board view. */
function parseActivityData(raw: string | null): unknown {
  if (raw == null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** Group `rows` into a Map keyed by `key(row)`, preserving row order
 *  within each bucket - so a query's ORDER BY carries through to the
 *  per-card arrays. */
function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const r of rows) {
    const k = key(r)
    const arr = out.get(k)
    if (arr) arr.push(r)
    else out.set(k, [r])
  }
  return out
}

export function getBoardView(db: Db, boardId?: string): BoardView | null {
  const b = boardId
    ? db.select().from(board).where(eq(board.id, boardId)).get()
    : db.select().from(board).orderBy(asc(board.position)).get()
  if (!b) return null

  const p = db.select().from(project).where(eq(project.id, b.projectId)).get()
  if (!p) return null

  // Creation order (UUIDv7 id is time-sortable), not alphabetical - the
  // header filter bar then defaults to "oldest first" and the renderer
  // layers any manual reorder on top (localStorage, lib/label-order).
  const labels = db
    .select()
    .from(label)
    .where(eq(label.boardId, b.id))
    .orderBy(asc(label.id))
    .all()

  const lists = db
    .select()
    .from(list)
    .where(eq(list.boardId, b.id))
    .orderBy(asc(list.position))
    .all()

  // Child tables are fetched ONCE per board (scoped via card → list
  // joins) and grouped per card in JS. The previous shape ran five
  // queries PER CARD, and this view refetches on every `changed`
  // broadcast - a few hundred cards meant a couple thousand queries
  // per mutation. Orderings match the old per-card queries (and the
  // headless reader in apps/mcp/src/headless.ts, which the parity
  // suite pins): labelIds by (cardId, labelId) - the export's
  // cardLabels sort; attachments createdAt asc; comments createdAt
  // desc; checklists/items position asc. Same-ms ties break on the
  // UUIDv7 id so the order is deterministic, matching the headless
  // reader's stable sort over the id-sorted dump.
  const boardCardIds = db
    .select({ id: card.id })
    .from(card)
    .innerJoin(list, eq(card.listId, list.id))
    .where(eq(list.boardId, b.id))

  const labelIdsByCard = groupBy(
    db
      .select({ cardId: cardLabel.cardId, labelId: cardLabel.labelId })
      .from(cardLabel)
      .where(inArray(cardLabel.cardId, boardCardIds))
      .orderBy(asc(cardLabel.cardId), asc(cardLabel.labelId))
      .all(),
    (r) => r.cardId
  )

  const attachmentsByCard = groupBy(
    db
      .select()
      .from(attachment)
      .where(inArray(attachment.cardId, boardCardIds))
      .orderBy(asc(attachment.createdAt), asc(attachment.id))
      .all(),
    (r) => r.cardId
  )

  const commentsByCard = groupBy(
    db
      .select()
      .from(comment)
      .where(inArray(comment.cardId, boardCardIds))
      .orderBy(desc(comment.createdAt), asc(comment.id))
      .all(),
    (r) => r.cardId
  )

  const checklistsByCard = groupBy(
    db
      .select()
      .from(checklist)
      .where(inArray(checklist.cardId, boardCardIds))
      .orderBy(asc(checklist.position))
      .all(),
    (r) => r.cardId
  )

  const itemsByChecklist = groupBy(
    db
      .select()
      .from(checklistItem)
      .where(
        inArray(
          checklistItem.checklistId,
          db
            .select({ id: checklist.id })
            .from(checklist)
            .innerJoin(card, eq(checklist.cardId, card.id))
            .innerJoin(list, eq(card.listId, list.id))
            .where(eq(list.boardId, b.id))
        )
      )
      .orderBy(asc(checklistItem.position))
      .all(),
    (r) => r.checklistId
  )

  // Per-card cap via a window function - fetching ALL activity rows
  // for a long-lived board would grow without bound (the feed table
  // is append-only). Secondary sort by id (UUIDv7 = time-sorted) so
  // events recorded within the same millisecond keep a stable order.
  const activityRows = db.all<{
    id: string
    cardId: string
    type: string
    data: string | null
    createdAt: number
  }>(sql`
    SELECT id, card_id AS cardId, type, data, created_at AS createdAt
    FROM (
      SELECT a.*, row_number() OVER (
        PARTITION BY a.card_id
        ORDER BY a.created_at DESC, a.id DESC
      ) AS rn
      FROM activity a
      INNER JOIN card c ON c.id = a.card_id
      INNER JOIN list l ON l.id = c.list_id
      WHERE l.board_id = ${b.id}
    )
    WHERE rn <= ${ACTIVITY_FEED_LIMIT}
    ORDER BY cardId ASC, createdAt DESC, id DESC
  `)
  const activitiesByCard = groupBy(
    activityRows.map((a) => ({
      id: a.id,
      cardId: a.cardId,
      type: a.type,
      // Raw sql bypasses drizzle's JSON-mode column mapping - parse
      // here so the view shape matches the mapped reads exactly. Tolerate
      // a malformed value (hand-edited DB, future migration) by passing
      // it through as null rather than throwing out the whole board view.
      data: parseActivityData(a.data),
      createdAt: a.createdAt
    })),
    (r) => r.cardId
  )

  const labelIdsFor = (cardId: string): string[] =>
    (labelIdsByCard.get(cardId) ?? []).map((r) => r.labelId)

  const attachmentsFor = (cardId: string) =>
    (attachmentsByCard.get(cardId) ?? []).map((at) => ({
      id: at.id,
      filename: at.filename,
      relPath: at.relPath,
      mime: at.mime,
      size: at.size,
      sourceUrl: at.sourceUrl,
      sourceTitle: at.sourceTitle,
      createdAt: at.createdAt
    }))

  const commentsFor = (cardId: string) =>
    (commentsByCard.get(cardId) ?? []).map((cm) => ({
      id: cm.id,
      body: cm.body,
      author: cm.author,
      createdAt: cm.createdAt,
      updatedAt: cm.updatedAt
    }))

  const checklistsFor = (cardId: string) =>
    (checklistsByCard.get(cardId) ?? []).map((cl) => ({
      id: cl.id,
      name: cl.name,
      position: cl.position,
      items: (itemsByChecklist.get(cl.id) ?? []).map((it) => ({
        id: it.id,
        text: it.text,
        completed: it.completed,
        position: it.position
      }))
    }))

  const activitiesFor = (cardId: string) => activitiesByCard.get(cardId) ?? []

  return {
    project: { id: p.id, name: p.name },
    board: {
      id: b.id,
      name: b.name,
      color: b.color,
      background: parseBackground(b.background),
      swimlaneMode: parseSwimlaneMode(b.swimlaneMode)
    },
    labels: labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
    lists: lists.map((l) => {
      // ADR-0032 per-list sort. Manual (null) keeps fractional-index
      // order; every other mode computes the order via cardOrdering
      // (mirrored by the headless reader for the MCP fallback).
      const sortMode = parseListSortMode(l.sortMode)
      const ordering = cardOrdering(sortMode)
      return {
      id: l.id,
      name: l.name,
      color: l.color,
      closed: l.closed,
      position: l.position,
      wipLimit: l.wipLimit,
      sortMode,
      onEnter: parseOnEnter(l.onEnter),
      cards: db
        .select()
        .from(card)
        .where(eq(card.listId, l.id))
        .orderBy(...ordering)
        .all()
        .map((c) => ({
          id: c.id,
          title: c.title,
          description: c.description,
          position: c.position,
          completed: c.completed,
          dueAt: c.dueAt,
          priority: parsePriority(c.priority),
          labelIds: labelIdsFor(c.id),
          checklists: checklistsFor(c.id),
          comments: commentsFor(c.id),
          attachments: attachmentsFor(c.id),
          coverAttachmentId: c.coverAttachmentId,
          activities: activitiesFor(c.id)
        }))
      }
    })
  }
}

/** Every attachment id - the orphan GC sweep diffs the
 *  `userData/attachments/<id>/` directory names against this set. */
export function listAttachmentIds(db: Db): string[] {
  return db
    .select({ id: attachment.id })
    .from(attachment)
    .all()
    .map((r) => r.id)
}

/** Every card id across every board (archived included). The Obsidian
 *  push's note pruning treats this as the "still exists" set - a note
 *  whose kanbini.id isn't here belongs to a deleted card. */
export function listCardIds(db: Db): string[] {
  return db
    .select({ id: card.id })
    .from(card)
    .all()
    .map((r) => r.id)
}

/** Single-card view - used by the MCP control channel so the AI can
 *  zoom in on a card without pulling the entire board. Returns null
 *  when the id doesn't match anything. */
export function getCardView(db: Db, cardId: string) {
  const c = db.select().from(card).where(eq(card.id, cardId)).get()
  if (!c) return null

  const labelIds = db
    .select({ id: cardLabel.labelId })
    .from(cardLabel)
    .where(eq(cardLabel.cardId, cardId))
    .all()
    .map((r) => r.id)

  const attachments = db
    .select()
    .from(attachment)
    .where(eq(attachment.cardId, cardId))
    .orderBy(asc(attachment.createdAt))
    .all()
    .map((at) => ({
      id: at.id,
      filename: at.filename,
      relPath: at.relPath,
      mime: at.mime,
      size: at.size,
      sourceUrl: at.sourceUrl,
      sourceTitle: at.sourceTitle,
      createdAt: at.createdAt
    }))

  const comments = db
    .select()
    .from(comment)
    .where(eq(comment.cardId, cardId))
    .orderBy(desc(comment.createdAt))
    .all()
    .map((cm) => ({
      id: cm.id,
      body: cm.body,
      author: cm.author,
      createdAt: cm.createdAt,
      updatedAt: cm.updatedAt
    }))

  const checklists = db
    .select()
    .from(checklist)
    .where(eq(checklist.cardId, cardId))
    .orderBy(asc(checklist.position))
    .all()
    .map((cl) => ({
      id: cl.id,
      name: cl.name,
      position: cl.position,
      items: db
        .select()
        .from(checklistItem)
        .where(eq(checklistItem.checklistId, cl.id))
        .orderBy(asc(checklistItem.position))
        .all()
        .map((it) => ({
          id: it.id,
          text: it.text,
          completed: it.completed,
          position: it.position
        }))
    }))

  const activities = db
    .select()
    .from(activity)
    .where(eq(activity.cardId, cardId))
    .orderBy(desc(activity.createdAt), desc(activity.id))
    .limit(ACTIVITY_FEED_LIMIT)
    .all()
    .map((a) => ({
      id: a.id,
      cardId: a.cardId,
      type: a.type,
      data: a.data,
      createdAt: a.createdAt
    }))

  return {
    id: c.id,
    title: c.title,
    description: c.description,
    position: c.position,
    completed: c.completed,
    dueAt: c.dueAt,
    priority: parsePriority(c.priority),
    labelIds,
    checklists,
    comments,
    attachments,
    coverAttachmentId: c.coverAttachmentId,
    activities
  }
}
