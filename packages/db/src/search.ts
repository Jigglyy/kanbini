import { and, desc, eq, or, sql } from 'drizzle-orm'
import type { Db } from './client'
import { board, card, cardLabel, label, list } from './schema'

// Global card search (M4-D). Substring (case-insensitive) match on
// card title, description, and any of the card's labels' names. One
// SQL query joins board → list → card → cardLabel → label, then we
// group at the JS level so each card appears once even if it matched
// across multiple columns / multiple labels. Sort prioritises a title
// hit, then a label hit, then a description hit; ties break by
// `updatedAt desc` so recently-touched cards float to the top.
//
// Substring (not fuzzy) on purpose: predictable, indexable by SQLite,
// and the kanban app's content is short enough that fuzzy adds little.
// Archived cards, closed lists, AND archived boards are excluded so
// the palette never surfaces hidden surface area (the home screen
// hides archived boards by default; jumping into one from search was
// inconsistent with that).

export interface SearchHit {
  cardId: string
  title: string
  /** First ~160 chars of the description, only when description matched. */
  descriptionSnippet: string | null
  boardId: string
  boardName: string
  listName: string
  /** Names of labels on this card that matched the query (may be empty). */
  matchedLabels: string[]
  /** Which surface had the strongest match - drives sort tier. */
  matchKind: 'title' | 'label' | 'description'
  updatedAt: number
}

const HARD_LIMIT = 100
const DEFAULT_LIMIT = 50
const SNIPPET_MAX = 160

/** Carve a short window around the first match site for the snippet -
 *  enough context for the user to see why this card surfaced. */
function snippetAround(text: string, qLower: string): string {
  const i = text.toLowerCase().indexOf(qLower)
  if (i < 0 || text.length <= SNIPPET_MAX) return text.slice(0, SNIPPET_MAX)
  const half = Math.floor((SNIPPET_MAX - qLower.length) / 2)
  const start = Math.max(0, i - half)
  const end = Math.min(text.length, start + SNIPPET_MAX)
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
}

export function searchCards(
  db: Db,
  query: string,
  limit: number = DEFAULT_LIMIT
): SearchHit[] {
  const q = query.trim()
  if (q.length === 0) return []
  const cap = Math.min(Math.max(1, limit), HARD_LIMIT)
  // SQLite LIKE is case-insensitive for ASCII by default; lowercase
  // both sides so non-ASCII (and labels) match too. Escape LIKE's
  // metacharacters so a literal % / _ in the query matches itself
  // instead of acting as a wildcard ("100%" used to match "100"
  // followed by anything). Every LIKE below carries ESCAPE '\\'.
  const qLower = q.toLowerCase()
  const escaped = qLower.replace(/[\\%_]/g, (ch) => `\\${ch}`)
  const pat = `%${escaped}%`

  const rows = db
    .select({
      cardId: card.id,
      title: card.title,
      description: card.description,
      updatedAt: card.updatedAt,
      boardId: board.id,
      boardName: board.name,
      listName: list.name,
      labelName: label.name,
      titleHit: sql<number>`(lower(${card.title}) LIKE ${pat} ESCAPE '\\')`,
      descHit: sql<number>`(lower(coalesce(${card.description}, '')) LIKE ${pat} ESCAPE '\\')`,
      labelHit: sql<number>`(lower(coalesce(${label.name}, '')) LIKE ${pat} ESCAPE '\\')`
    })
    .from(card)
    .innerJoin(list, eq(card.listId, list.id))
    .innerJoin(board, eq(list.boardId, board.id))
    .leftJoin(cardLabel, eq(cardLabel.cardId, card.id))
    .leftJoin(label, eq(label.id, cardLabel.labelId))
    .where(
      and(
        eq(card.archived, false),
        eq(list.closed, false),
        eq(board.archived, false),
        or(
          sql`lower(${card.title}) LIKE ${pat} ESCAPE '\\'`,
          sql`lower(coalesce(${card.description}, '')) LIKE ${pat} ESCAPE '\\'`,
          sql`lower(coalesce(${label.name}, '')) LIKE ${pat} ESCAPE '\\'`
        )
      )
    )
    .orderBy(desc(card.updatedAt))
    .all()

  // Roll up to one row per card. Same card can appear N times because
  // of the cardLabel join.
  const byCard = new Map<string, SearchHit>()
  for (const r of rows) {
    let hit = byCard.get(r.cardId)
    if (!hit) {
      const kind: SearchHit['matchKind'] = r.titleHit
        ? 'title'
        : r.labelHit
          ? 'label'
          : 'description'
      hit = {
        cardId: r.cardId,
        title: r.title,
        descriptionSnippet:
          r.descHit && r.description ? snippetAround(r.description, qLower) : null,
        boardId: r.boardId,
        boardName: r.boardName,
        listName: r.listName,
        matchedLabels: [],
        matchKind: kind,
        updatedAt: r.updatedAt
      }
      byCard.set(r.cardId, hit)
    }
    if (r.labelHit && r.labelName && !hit.matchedLabels.includes(r.labelName)) {
      hit.matchedLabels.push(r.labelName)
      // Promote a card whose only original match was a description to
      // 'label' if a label hit also turns up - labels are stronger.
      if (hit.matchKind === 'description') hit.matchKind = 'label'
    }
  }

  // Tier sort: title (0) → label (1) → description (2); tie → newer.
  const tier = { title: 0, label: 1, description: 2 } as const
  return [...byCard.values()]
    .sort((a, b) => {
      const t = tier[a.matchKind] - tier[b.matchKind]
      if (t !== 0) return t
      return b.updatedAt - a.updatedAt
    })
    .slice(0, cap)
}
