import { and, asc, desc, eq } from 'drizzle-orm'
import {
  TEMPLATE_FORMAT_VERSION,
  type TemplateBoardData,
  type TemplateInstantiateResult,
  type TemplateListData,
  type TemplateSummary,
  newId,
  orderKeyBetween,
  orderKeysBetween,
  zBoardBackground,
  zCardPriority,
  zTemplateBoardData,
  zTemplateListData
} from '@kanbini/shared'
import type { Db } from './client'
import { ensureDefaultProjectId } from './crud'
import {
  board,
  card,
  cardLabel,
  checklist,
  checklistItem,
  label,
  list,
  template
} from './schema'

// ADR-0038 · save + instantiate flows for board / list templates.
// All flows are transactional - a half-applied template would leave the
// new entity in a confusing state that the user can't easily clean up.

const now = (): number => Date.now()

// ---- save -----------------------------------------------------------

/** Snapshot a board into a `template` row. Excludes time-bound data
 *  (comments, activity, attachments, dueAt). Label assignments survive
 *  via template-internal ids that the cards reference. */
export function saveBoardTemplate(
  db: Db,
  sourceBoardId: string,
  name: string
): { id: string } {
  return db.transaction((tx) => {
    const b = tx.select().from(board).where(eq(board.id, sourceBoardId)).get()
    if (!b) throw new Error(`Board ${sourceBoardId} not found`)

    const dbLabels = tx
      .select()
      .from(label)
      .where(eq(label.boardId, sourceBoardId))
      .orderBy(asc(label.name))
      .all()
    // Map real label.id → template-internal tmplId so cards can
    // reference labels by something other than the source ids.
    const tmplLabelIdByReal = new Map<string, string>()
    const tplLabels = dbLabels.map((lb) => {
      const tmplId = newId()
      tmplLabelIdByReal.set(lb.id, tmplId)
      return { tmplId, name: lb.name, color: lb.color }
    })

    const dbLists = tx
      .select()
      .from(list)
      .where(and(eq(list.boardId, sourceBoardId), eq(list.closed, false)))
      .orderBy(asc(list.position))
      .all()

    const tplLists = dbLists.map((l) => ({
      name: l.name,
      color: l.color,
      position: l.position,
      wipLimit: l.wipLimit,
      sortMode:
        l.sortMode === 'created-asc'
          ? ('created-asc' as const)
          : l.sortMode === 'created-desc'
            ? ('created-desc' as const)
            : null,
      cards: snapshotCards(tx, l.id, tmplLabelIdByReal)
    }))

    // Soft-narrow the stored background - a malformed value (older
    // build, hand-edited DB, future format the current build doesn't
    // recognise) drops to null in the template rather than failing the
    // save outright. Same pattern as `parseBackground` in data.ts.
    const bgParsed = zBoardBackground.safeParse(b.background)
    const payload: TemplateBoardData = {
      version: TEMPLATE_FORMAT_VERSION,
      board: {
        name: b.name,
        description: b.description,
        color: b.color,
        background: bgParsed.success ? bgParsed.data : null,
        swimlaneMode: b.swimlaneMode === 'priority' ? 'priority' : null
      },
      labels: tplLabels,
      lists: tplLists
    }
    const parsed = zTemplateBoardData.parse(payload)

    const id = newId()
    tx.insert(template)
      .values({ id, name, kind: 'board', data: parsed })
      .run()
    return { id }
  })
}

/** Snapshot a single list (with its cards + checklists) into a
 *  `template` row. Label assignments are dropped - labels live on the
 *  source board, and a list template can be pasted into any board. */
export function saveListTemplate(
  db: Db,
  sourceListId: string,
  name: string
): { id: string } {
  return db.transaction((tx) => {
    const l = tx.select().from(list).where(eq(list.id, sourceListId)).get()
    if (!l) throw new Error(`List ${sourceListId} not found`)

    const cards = snapshotCards(tx, sourceListId, null).map((c) => ({
      title: c.title,
      description: c.description,
      position: c.position,
      priority: c.priority,
      completed: c.completed,
      checklists: c.checklists
    }))

    const payload: TemplateListData = {
      version: TEMPLATE_FORMAT_VERSION,
      list: {
        name: l.name,
        color: l.color,
        wipLimit: l.wipLimit,
        sortMode:
          l.sortMode === 'created-asc' || l.sortMode === 'created-desc'
            ? l.sortMode
            : null
      },
      cards
    }
    const parsed = zTemplateListData.parse(payload)

    const id = newId()
    tx.insert(template)
      .values({ id, name, kind: 'list', data: parsed })
      .run()
    return { id }
  })
}

/** Read every card in a list into the template card shape. Pass the
 *  label-id remap for board templates (null = drop label assignments,
 *  used by list templates). */
function snapshotCards(
  tx: Db,
  listId: string,
  tmplLabelIdByReal: Map<string, string> | null
) {
  const cards = tx
    .select()
    .from(card)
    .where(eq(card.listId, listId))
    .orderBy(asc(card.position))
    .all()
  return cards.map((c) => {
    const labelIds = tmplLabelIdByReal
      ? tx
          .select({ id: cardLabel.labelId })
          .from(cardLabel)
          .where(eq(cardLabel.cardId, c.id))
          .all()
          .map((r) => r.id)
          .map((real) => tmplLabelIdByReal.get(real))
          .filter((x): x is string => typeof x === 'string')
      : []

    const checklists = tx
      .select()
      .from(checklist)
      .where(eq(checklist.cardId, c.id))
      .orderBy(asc(checklist.position))
      .all()
      .map((cl) => ({
        name: cl.name,
        position: cl.position,
        items: tx
          .select()
          .from(checklistItem)
          .where(eq(checklistItem.checklistId, cl.id))
          .orderBy(asc(checklistItem.position))
          .all()
          .map((it) => ({
            text: it.text,
            completed: it.completed,
            position: it.position
          }))
      }))

    const priorityParsed = zCardPriority.safeParse(c.priority)
    return {
      title: c.title,
      description: c.description,
      position: c.position,
      priority: priorityParsed.success ? priorityParsed.data : null,
      completed: c.completed,
      labelTmplIds: labelIds,
      checklists
    }
  })
}

// ---- list / read / mutate / delete ----------------------------------

/** Summaries of every template, newest first. Counts are derived from
 *  the parsed payload - keeps the row schema clean (no denormalised
 *  count columns to drift out of date). */
export function listTemplates(db: Db): TemplateSummary[] {
  const rows = db
    .select()
    .from(template)
    .orderBy(desc(template.updatedAt))
    .all()
  return rows.map((r) => {
    let listCount = 0
    let cardCount = 0
    if (r.kind === 'board') {
      const parsed = zTemplateBoardData.safeParse(r.data)
      if (parsed.success) {
        listCount = parsed.data.lists.length
        cardCount = parsed.data.lists.reduce(
          (sum, l) => sum + l.cards.length,
          0
        )
      }
    } else {
      const parsed = zTemplateListData.safeParse(r.data)
      if (parsed.success) {
        listCount = 1
        cardCount = parsed.data.cards.length
      }
    }
    return {
      id: r.id,
      kind: r.kind,
      name: r.name,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      listCount,
      cardCount
    }
  })
}

export function renameTemplate(db: Db, id: string, name: string): void {
  db.update(template)
    .set({ name, updatedAt: now() })
    .where(eq(template.id, id))
    .run()
}

export function deleteTemplate(db: Db, id: string): void {
  db.delete(template).where(eq(template.id, id)).run()
}

// ---- instantiate ----------------------------------------------------

/** Replay a board template into a brand-new board on the default
 *  project. Returns the new board id so the renderer can navigate. */
export function instantiateBoardTemplate(
  db: Db,
  templateId: string
): TemplateInstantiateResult {
  return db.transaction((tx) => {
    const row = tx
      .select()
      .from(template)
      .where(and(eq(template.id, templateId), eq(template.kind, 'board')))
      .get()
    if (!row) throw new Error(`Board template ${templateId} not found`)
    const data = zTemplateBoardData.parse(row.data)

    const projectId = ensureDefaultProjectId(tx)
    const boardId = newId()
    const after =
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
        background: data.board.background,
        swimlaneMode: data.board.swimlaneMode,
        position: orderKeyBetween(after, null)
      })
      .run()

    // Mint fresh real label ids and remember the template→real mapping
    // so card.labelTmplIds can be remapped during card insertion.
    const realLabelIdByTmpl = new Map<string, string>()
    for (const lb of data.labels) {
      const realId = newId()
      realLabelIdByTmpl.set(lb.tmplId, realId)
      tx.insert(label)
        .values({ id: realId, boardId, name: lb.name, color: lb.color })
        .run()
    }

    // Re-mint list positions in template order; the stored positions
    // were the source board's keys and may collide with future inserts
    // on the new board if we kept them verbatim.
    const listKeys = orderKeysBetween(null, null, data.lists.length)
    data.lists.forEach((l, i) => {
      const newListId = newId()
      tx.insert(list)
        .values({
          id: newListId,
          boardId,
          name: l.name,
          color: l.color,
          position: listKeys[i]!,
          wipLimit: l.wipLimit,
          sortMode: l.sortMode
        })
        .run()
      insertTemplateCards(tx, newListId, l.cards, realLabelIdByTmpl)
    })

    return { kind: 'board', boardId, listId: null }
  })
}

/** Append a list template (and its cards) to an existing board. */
export function instantiateListTemplate(
  db: Db,
  templateId: string,
  targetBoardId: string
): TemplateInstantiateResult {
  return db.transaction((tx) => {
    const row = tx
      .select()
      .from(template)
      .where(and(eq(template.id, templateId), eq(template.kind, 'list')))
      .get()
    if (!row) throw new Error(`List template ${templateId} not found`)
    const data = zTemplateListData.parse(row.data)

    const boardExists = tx
      .select({ id: board.id })
      .from(board)
      .where(eq(board.id, targetBoardId))
      .get()
    if (!boardExists) throw new Error(`Target board ${targetBoardId} not found`)

    const after =
      tx
        .select({ p: list.position })
        .from(list)
        .where(eq(list.boardId, targetBoardId))
        .orderBy(desc(list.position))
        .limit(1)
        .get()?.p ?? null

    const listId = newId()
    tx.insert(list)
      .values({
        id: listId,
        boardId: targetBoardId,
        name: data.list.name,
        color: data.list.color,
        position: orderKeyBetween(after, null),
        wipLimit: data.list.wipLimit,
        sortMode: data.list.sortMode
      })
      .run()
    // List templates carry cards without label assignments - pass an
    // empty remap so the per-card label loop is a no-op.
    insertTemplateCards(tx, listId, data.cards, new Map())

    return { kind: 'list', boardId: targetBoardId, listId }
  })
}

/** Insert a list's worth of template cards. Card positions are
 *  re-minted in template order so the new list's keys start fresh. */
function insertTemplateCards(
  tx: Db,
  listId: string,
  cards: Array<{
    title: string
    description: string | null
    priority: TemplateBoardData['lists'][number]['cards'][number]['priority']
    completed: boolean
    checklists: TemplateBoardData['lists'][number]['cards'][number]['checklists']
    labelTmplIds?: string[]
  }>,
  realLabelIdByTmpl: Map<string, string>
): void {
  if (cards.length === 0) return
  const cardKeys = orderKeysBetween(null, null, cards.length)
  cards.forEach((c, i) => {
    const cardId = newId()
    tx.insert(card)
      .values({
        id: cardId,
        listId,
        title: c.title,
        description: c.description,
        priority: c.priority ?? undefined,
        completed: c.completed,
        position: cardKeys[i]!
      })
      .run()

    if (c.labelTmplIds && c.labelTmplIds.length > 0) {
      const realIds = c.labelTmplIds
        .map((t) => realLabelIdByTmpl.get(t))
        .filter((x): x is string => typeof x === 'string')
      if (realIds.length > 0) {
        tx.insert(cardLabel)
          .values(realIds.map((labelId) => ({ cardId, labelId })))
          .run()
      }
    }

    if (c.checklists.length > 0) {
      for (const cl of c.checklists) {
        const clId = newId()
        tx.insert(checklist)
          .values({ id: clId, cardId, name: cl.name, position: cl.position })
          .run()
        if (cl.items.length > 0) {
          tx.insert(checklistItem)
            .values(
              cl.items.map((it) => ({
                id: newId(),
                checklistId: clId,
                text: it.text,
                completed: it.completed,
                position: it.position
              }))
            )
            .run()
        }
      }
    }
  })
}
