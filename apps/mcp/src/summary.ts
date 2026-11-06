import {
  describeRepeat,
  isBlockedBy,
  type BoardView,
  type CardPriority,
  type CardView,
  type ListView
} from '@kanbini/shared'

// Light reads for the AI. A full board view carries every card's
// description, comments, checklists and activity feed: Dice Inc's was
// about 1.8 MB, far past what a model can read in one go. These turn a
// view into one short line per card, with the details left to
// kanbini_get_card. Fields that are empty / false / zero are left out,
// which is most of them on most cards.
//
// Cards are named by `number` (with the board), not id: every write tool
// takes `#142` + boardId, and dropping the 36-character ids is about a
// third of the summary's size.

export interface CardSummary {
  number: number
  title: string
  completed?: true
  /** Local calendar day, YYYY-MM-DD. */
  due?: string
  priority?: CardPriority
  /** Label NAMES (the write tools take names too). */
  labels?: string[]
  /** Ticked / total checklist items across the card's checklists. */
  checklist?: string
  /** It has a description (read it with kanbini_get_card). */
  description?: true
  comments?: number
  attachments?: number
  /** Waiting on a card that's still open. */
  blocked?: true
  repeat?: string
}

export interface ListSummary {
  id: string
  name: string
  cardCount: number
  /** Archived list: its cards are left out of the summary. */
  closed?: true
  wipLimit?: number
  sortMode?: string
  onEnter?: string
  cards: CardSummary[]
  /** Cards past the per-list cap, left out (kanbini_get_list_cards
   *  pages through them). */
  moreCards?: number
}

/** Cards per list in the board summary unless the caller asks for more:
 *  enough for any working list, while a 400-card Done list doesn't
 *  dominate the read. */
export const SUMMARY_CARDS_PER_LIST = 50

export interface BoardSummary {
  board: { id: string; name: string }
  labels: { id: string; name: string; color: string }[]
  lists: ListSummary[]
}

/** YYYY-MM-DD of an epoch-ms timestamp in local time (due dates are
 *  stored as local midnight of the due day). */
export function localDate(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Local midnight of the day after the one `ms` falls on (the Date
 *  constructor, so a DST change can't shift it). */
export function nextLocalDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Local midnight of a YYYY-MM-DD day, as epoch ms. Throws on anything
 *  that isn't a real calendar date. */
export function parseLocalDate(s: string): number {
  const m = DATE_RE.exec(s.trim())
  if (!m) throw new Error(`"${s}" is not a date: use YYYY-MM-DD, e.g. 2026-11-07.`)
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(y, mo - 1, d)
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) {
    throw new Error(`"${s}" is not a real date.`)
  }
  return date.getTime()
}

export function summarizeCard(card: CardView, labelNames: ReadonlyMap<string, string>): CardSummary {
  const s: CardSummary = { number: card.number, title: card.title }
  if (card.completed) s.completed = true
  if (card.dueAt != null) s.due = localDate(card.dueAt)
  if (card.priority) s.priority = card.priority
  const labels = card.labelIds.map((id) => labelNames.get(id)).filter((n): n is string => !!n)
  if (labels.length > 0) s.labels = labels
  let done = 0
  let total = 0
  for (const cl of card.checklists) {
    total += cl.items.length
    done += cl.items.filter((i) => i.completed).length
  }
  if (total > 0) s.checklist = `${done}/${total}`
  if (card.description && card.description.trim() !== '') s.description = true
  if (card.comments.length > 0) s.comments = card.comments.length
  if (card.attachments.length > 0) s.attachments = card.attachments.length
  if (!card.completed && isBlockedBy(card.blockedBy)) s.blocked = true
  if (card.repeat) s.repeat = describeRepeat(card.repeat)
  return s
}

export const labelNameMap = (view: BoardView): Map<string, string> =>
  new Map(view.labels.map((l) => [l.id, l.name]))

function listHeader(list: ListView): Omit<ListSummary, 'cards'> {
  const h: Omit<ListSummary, 'cards'> = {
    id: list.id,
    name: list.name,
    cardCount: list.cards.length
  }
  if (list.closed) h.closed = true
  if (list.wipLimit != null) h.wipLimit = list.wipLimit
  if (list.sortMode) h.sortMode = list.sortMode
  if (list.onEnter) h.onEnter = list.onEnter.kind
  return h
}

export function summarizeBoard(
  view: BoardView,
  cardsPerList: number = SUMMARY_CARDS_PER_LIST
): BoardSummary {
  const names = labelNameMap(view)
  return {
    board: { id: view.board.id, name: view.board.name },
    labels: view.labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
    lists: view.lists.map((list) => {
      if (list.closed) return { ...listHeader(list), cards: [] }
      const shown = list.cards.slice(0, cardsPerList)
      return {
        ...listHeader(list),
        cards: shown.map((c) => summarizeCard(c, names)),
        ...(list.cards.length > shown.length ? { moreCards: list.cards.length - shown.length } : {})
      }
    })
  }
}

export interface CardFilter {
  status?: 'open' | 'completed' | 'all'
  /** Label id the card must carry. */
  labelId?: string
  /** 'none' = unprioritised. */
  priority?: CardPriority | 'none'
  /** Inclusive local days, as epoch ms of local midnight. */
  dueFrom?: number
  dueTo?: number
  hasDue?: boolean
  /** Case-insensitive substring of the title or description. */
  query?: string
}

export function filterCards(cards: readonly CardView[], f: CardFilter): CardView[] {
  const q = f.query?.trim().toLowerCase()
  return cards.filter((c) => {
    if (f.status === 'open' && c.completed) return false
    if (f.status === 'completed' && !c.completed) return false
    if (f.labelId && !c.labelIds.includes(f.labelId)) return false
    if (f.priority !== undefined && (c.priority ?? 'none') !== f.priority) return false
    if (f.hasDue !== undefined && (c.dueAt != null) !== f.hasDue) return false
    if (f.dueFrom !== undefined && (c.dueAt == null || c.dueAt < f.dueFrom)) return false
    if (f.dueTo !== undefined && (c.dueAt == null || c.dueAt > f.dueTo)) return false
    if (q) {
      const hay = `${c.title}\n${c.description ?? ''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
}
