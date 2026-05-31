import { desc, eq } from 'drizzle-orm'
import {
  type TrelloBoard,
  type TrelloImportSummary,
  newId,
  orderKeyBetween
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
  list
} from './schema'

// Trello board import. Unlike importFromFolder (M4-B), this is
// ADDITIVE - it creates one new board next to existing data and never
// wipes. Trello's 24-char hex ids are replaced with fresh UUIDv7s;
// in-memory id maps re-stitch every foreign key. Trello's float `pos`
// values are sorted, then re-minted as fractional-index strings.
//
// Not imported: attachment files (remote trello.com URLs - fetching
// them would breach offline-by-default, ADR-0023; the skipped count is
// surfaced) and labels no card references (avoids blank-chip clutter).
//
// Everything comes in ACTIVE. Trello's `closed` lists / cards are NOT
// carried over: getBoardView returns them but the renderer hides
// closed lists and there is no reopen UI - a "closed" import would
// silently and unrecoverably hide cards. An import should land every
// card visible; the user can archive/delete from Kanbini afterwards.

/** Trello colour name → nearest Kanbini palette swatch. Mirrors
 *  ACCENTS in apps/renderer/src/lib/palette.ts - kept in sync by hand
 *  (this package can't import from the renderer). */
const TRELLO_COLOR: Record<string, string> = {
  green: 'oklch(0.64 0.15 150)',
  lime: 'oklch(0.64 0.15 150)',
  yellow: 'oklch(0.70 0.13 85)',
  orange: 'oklch(0.70 0.13 85)',
  red: 'oklch(0.62 0.17 25)',
  pink: 'oklch(0.62 0.17 25)',
  purple: 'oklch(0.62 0.16 300)',
  blue: 'oklch(0.62 0.15 250)',
  sky: 'oklch(0.62 0.15 250)',
  black: 'oklch(0.62 0.05 240)'
}
const DEFAULT_COLOR = 'oklch(0.62 0.15 250)' // blue

function mapColor(trelloColor: string | null): string {
  if (!trelloColor) return DEFAULT_COLOR
  // Strip Trello's _dark / _light shade suffix before lookup.
  const base = trelloColor.replace(/_(dark|light)$/, '')
  return TRELLO_COLOR[base] ?? DEFAULT_COLOR
}

export function importFromTrello(
  db: Db,
  trello: TrelloBoard
): TrelloImportSummary {
  // Resolve the (lone, hidden) project before the transaction - the
  // helper is typed for `Db`, not a tx handle.
  const projectId = ensureDefaultProjectId(db)

  return db.transaction((tx) => {
    // New board, appended after the project's last board.
    const boardId = newId()
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
        name: trello.name,
        description: trello.desc.trim() ? trello.desc : null,
        position: orderKeyBetween(lastBoardPos, null)
      })
      .run()

    // Lists - sorted by Trello pos, fresh sequential keys.
    const sortedLists = [...trello.lists].sort((a, b) => a.pos - b.pos)
    const listIdMap = new Map<string, string>()
    let listPos: string | null = null
    for (const l of sortedLists) {
      const id = newId()
      listIdMap.set(l.id, id)
      listPos = orderKeyBetween(listPos, null)
      tx.insert(list)
        .values({ id, boardId, name: l.name, position: listPos })
        .run()
    }

    // Labels - only those referenced by at least one card.
    const usedLabelIds = new Set<string>()
    for (const c of trello.cards)
      for (const lid of c.idLabels) usedLabelIds.add(lid)
    const labelIdMap = new Map<string, string>()
    for (const lb of trello.labels) {
      if (!usedLabelIds.has(lb.id)) continue
      const id = newId()
      labelIdMap.set(lb.id, id)
      tx.insert(label)
        .values({ id, boardId, name: lb.name, color: mapColor(lb.color) })
        .run()
    }

    // Cards - grouped by list, sorted by pos within each list. Cards
    // whose idList isn't a list we imported are dropped silently.
    const cardIdMap = new Map<string, string>()
    let cardCount = 0
    let cardLabelCount = 0
    let skippedAttachments = 0
    for (const l of sortedLists) {
      const newListId = listIdMap.get(l.id)!
      const listCards = trello.cards
        .filter((c) => c.idList === l.id)
        .sort((a, b) => a.pos - b.pos)
      let cardPos: string | null = null
      for (const c of listCards) {
        const id = newId()
        cardIdMap.set(c.id, id)
        cardPos = orderKeyBetween(cardPos, null)
        const dueMs = c.due ? Date.parse(c.due) : NaN
        tx.insert(card)
          .values({
            id,
            listId: newListId,
            title: c.name,
            description: c.desc.trim() ? c.desc : null,
            position: cardPos,
            dueAt: Number.isNaN(dueMs) ? null : dueMs,
            completed: c.dueComplete
          })
          .run()
        cardCount++
        skippedAttachments += c.attachments.length
        for (const lid of c.idLabels) {
          const labelId = labelIdMap.get(lid)
          if (!labelId) continue
          tx.insert(cardLabel).values({ cardId: id, labelId }).run()
          cardLabelCount++
        }
      }
    }

    // Cards whose idList referenced no imported list never made it into
    // any list bucket above - count them so the drop isn't invisible.
    const skippedCards = trello.cards.filter(
      (c) => !listIdMap.has(c.idList)
    ).length

    // Checklists + items - grouped by card, each sorted by pos. A
    // checklist on a card we didn't import (orphan) is dropped.
    const checklistsByCard = new Map<string, TrelloBoard['checklists']>()
    for (const cl of trello.checklists) {
      const arr = checklistsByCard.get(cl.idCard) ?? []
      arr.push(cl)
      checklistsByCard.set(cl.idCard, arr)
    }
    let checklistCount = 0
    let checklistItemCount = 0
    let skippedChecklists = 0
    for (const [trelloCardId, cls] of checklistsByCard) {
      const newCardId = cardIdMap.get(trelloCardId)
      if (!newCardId) {
        skippedChecklists += cls.length
        continue
      }
      let clPos: string | null = null
      for (const cl of [...cls].sort((a, b) => a.pos - b.pos)) {
        const clId = newId()
        clPos = orderKeyBetween(clPos, null)
        tx.insert(checklist)
          .values({ id: clId, cardId: newCardId, name: cl.name, position: clPos })
          .run()
        checklistCount++
        let itPos: string | null = null
        for (const it of [...cl.checkItems].sort((a, b) => a.pos - b.pos)) {
          itPos = orderKeyBetween(itPos, null)
          tx.insert(checklistItem)
            .values({
              id: newId(),
              checklistId: clId,
              text: it.name,
              completed: it.state === 'complete',
              position: itPos
            })
            .run()
          checklistItemCount++
        }
      }
    }

    return {
      boardId,
      boardName: trello.name,
      counts: {
        lists: listIdMap.size,
        cards: cardCount,
        labels: labelIdMap.size,
        cardLabels: cardLabelCount,
        checklists: checklistCount,
        checklistItems: checklistItemCount
      },
      skipped: {
        attachments: skippedAttachments,
        cards: skippedCards,
        checklists: skippedChecklists
      }
    }
  })
}
