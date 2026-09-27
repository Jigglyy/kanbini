import { and, eq, gte, inArray, isNotNull, lt, or, sql } from 'drizzle-orm'
import {
  AGENDA_COMPLETION_ACTIVITY_TYPES,
  AGENDA_DEFAULT_COMPLETED_DAYS,
  AGENDA_DEFAULT_UPCOMING_DAYS,
  agendaWindows,
  buildAgendaView,
  type AgendaCandidate,
  type AgendaOptions,
  type AgendaView
} from '@kanbini/shared'
import type { Db } from './client'
import { parsePriority } from './data'
import { activity, board, card, cardDependency, list } from './schema'

// Cross-board agenda: overdue / due today / upcoming / recently
// completed, across every board. Section rules + ordering live in
// `buildAgendaView` (@kanbini/shared) so the MCP headless reader applies
// the exact same ones; this file only gathers candidates.
//
// There is no `completed_at` column. A card's completion time is its
// newest `completed` / `rule-completed` activity row, which every
// completion path (card detail, bulk complete, list on-enter rule, MCP)
// already writes inside the same transaction as the flip. A card
// completed with no such row (Trello import, template instantiate)
// simply never shows under "recently completed" - it wasn't completed
// recently.
//
// Hidden surface stays hidden: archived cards, closed lists and archived
// boards are excluded, same as search. Each open item says whether it's
// `blocked` (waiting on an open card), so a plan for the day can skip it.

export function getAgenda(db: Db, opts: AgendaOptions = {}): AgendaView {
  const now = opts.now ?? Date.now()
  const upcomingDays = opts.upcomingDays ?? AGENDA_DEFAULT_UPCOMING_DAYS
  const completedDays = opts.completedDays ?? AGENDA_DEFAULT_COMPLETED_DAYS
  const w = agendaWindows(now, upcomingDays, completedDays)

  // Newest completion per card. Only rows inside the completed window
  // matter: if a card's newest completion is older than that, it's out
  // either way, so filtering first gives the same answer on fewer rows.
  const lastCompleted = db
    .select({
      cardId: activity.cardId,
      at: sql<number>`max(${activity.createdAt})`.as('at')
    })
    .from(activity)
    .where(
      and(
        inArray(activity.type, [...AGENDA_COMPLETION_ACTIVITY_TYPES]),
        isNotNull(activity.cardId),
        gte(activity.createdAt, w.completedSince)
      )
    )
    .groupBy(activity.cardId)
    .as('last_completed')

  const rows = db
    .select({
      cardId: card.id,
      title: card.title,
      dueAt: card.dueAt,
      priority: card.priority,
      completed: card.completed,
      listId: list.id,
      listName: list.name,
      boardId: board.id,
      boardName: board.name,
      boardColor: board.color,
      completedAt: lastCompleted.at,
      // Any "waiting on" link to a card that's still open (not completed,
      // not archived) - the same rule as isOpenBlocker in the renderer.
      blocked: sql<number>`exists (
        select 1 from ${cardDependency} d
        inner join ${card} bc on bc.id = d.blocker_id
        where d.card_id = ${card.id} and bc.completed = 0 and bc.archived = 0
      )`
    })
    .from(card)
    .innerJoin(list, eq(card.listId, list.id))
    .innerJoin(board, eq(list.boardId, board.id))
    .leftJoin(lastCompleted, eq(lastCompleted.cardId, card.id))
    .where(
      and(
        eq(card.archived, false),
        eq(list.closed, false),
        eq(board.archived, false),
        or(
          and(
            eq(card.completed, false),
            isNotNull(card.dueAt),
            lt(card.dueAt, w.upcomingEnd)
          ),
          and(eq(card.completed, true), isNotNull(lastCompleted.at))
        )
      )
    )
    .all()

  const candidates: AgendaCandidate[] = rows.map((r) => ({
    cardId: r.cardId,
    title: r.title,
    boardId: r.boardId,
    boardName: r.boardName,
    boardColor: r.boardColor,
    listId: r.listId,
    listName: r.listName,
    dueAt: r.dueAt,
    priority: parsePriority(r.priority),
    completed: r.completed,
    completedAt: r.completedAt ?? null,
    blocked: Boolean(r.blocked)
  }))

  return buildAgendaView(candidates, { ...opts, now, upcomingDays, completedDays })
}
