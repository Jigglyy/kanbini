import {
  parseCardNumberRef,
  type BoardView,
  type BoardsListView,
  type CardView
} from '@kanbini/shared'

// Turning what the AI says into ids. Every write tool takes, wherever it
// needs a board / list / label / card:
//
//   - an id (passed through as-is),
//   - a board, list or label by its exact name (case-insensitive),
//   - a card by its number (`#142` or `142`),
//   - inside kanbini_batch, `$name`: the thing an earlier step made with
//     `ref: "name"`.
//
// Names and numbers are looked up on a board, so they come with
// `boardId` (an id or the board's name). One board view is fetched per
// board per call, and only when something isn't already an id.
//
// The finders are pure so the read tools can use them against a view
// that came from the on-disk export (app closed); the Resolver adds the
// lookups and the batch's own bookkeeping on top.

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REF_RE = /^\$[A-Za-z0-9_-]+$/

export const looksLikeId = (s: string): boolean => ID_RE.test(s.trim())
export const isBatchRef = (s: string): boolean => REF_RE.test(s.trim())

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()
const quoteList = (names: string[]) =>
  names.length === 0 ? 'none' : names.map((n) => `"${n}"`).join(', ')

/** Pick the one item named `ref`. Open items win over closed / archived
 *  ones; two open items with that name is an error naming both. */
function pickByName<T extends { id: string; name: string }>(
  items: readonly T[],
  ref: string,
  kind: string,
  where: string,
  isClosed: (t: T) => boolean = () => false
): T {
  const want = norm(ref)
  const hits = items.filter((i) => norm(i.name) === want)
  const open = hits.filter((i) => !isClosed(i))
  const pool = open.length > 0 ? open : hits
  if (pool.length === 1) return pool[0]!
  if (pool.length > 1) {
    throw new Error(
      `${pool.length} ${kind}s are named "${ref}" ${where}; use the id instead (${pool
        .map((i) => i.id)
        .join(', ')}).`
    )
  }
  const names = items.filter((i) => !isClosed(i)).map((i) => i.name)
  throw new Error(`No ${kind} named "${ref}" ${where}. ${kind[0]!.toUpperCase()}${kind.slice(1)}s there: ${quoteList(names)}.`)
}

export function findBoard(boards: BoardsListView, ref: string): string {
  if (looksLikeId(ref)) return ref.trim()
  return pickByName(boards, ref, 'board', 'in Kanbini', (b) => b.archived).id
}

export function findList(view: BoardView, ref: string): BoardView['lists'][number] {
  if (looksLikeId(ref)) {
    const list = view.lists.find((l) => l.id === ref.trim())
    if (!list) throw new Error(`There is no list ${ref} on "${view.board.name}".`)
    return list
  }
  return pickByName(view.lists, ref, 'list', `on "${view.board.name}"`, (l) => l.closed)
}

export function findLabel(view: BoardView, ref: string): string {
  if (looksLikeId(ref)) return ref.trim()
  return pickByName(view.labels, ref, 'label', `on "${view.board.name}"`).id
}

export function findCardByNumber(view: BoardView, n: number): CardView | null {
  for (const list of view.lists) {
    const card = list.cards.find((c) => c.number === n)
    if (card) return card
  }
  return null
}

export interface ResolverIO {
  listBoards(): Promise<BoardsListView>
  boardView(boardId: string): Promise<BoardView | null>
  /** card.get: by id, or by number on a board (archived cards too). */
  card(ref: string, boardId?: string): Promise<CardView | null>
}

export class Resolver {
  /** `$name` -> id, for things made earlier in this batch. */
  private readonly refs = new Map<string, string>()
  /** Boards made in this batch: no view to fetch yet. */
  private readonly newBoards = new Set<string>()
  /** Lists / labels made in this batch, by board then name. */
  private readonly newLists = new Map<string, Map<string, string>>()
  private readonly newLabels = new Map<string, Map<string, string>>()
  /** A card's labels as earlier steps of this batch left them. */
  private readonly pendingLabels = new Map<string, string[]>()
  private boardsCache: Promise<BoardsListView> | null = null
  private readonly views = new Map<string, Promise<BoardView | null>>()
  private readonly cards = new Map<string, Promise<CardView | null>>()

  constructor(
    private readonly io: ResolverIO,
    /** The batch's `boardId`, used by steps that don't name one. */
    private readonly defaultBoard?: string
  ) {}

  /** Remember `$name` for a thing a step just made. */
  defineRef(name: string | undefined, id: string): void {
    if (name === undefined) return
    const key = `$${name.replace(/^\$/, '')}`
    if (!isBatchRef(key)) {
      throw new Error(`ref "${name}" may only use letters, digits, - and _.`)
    }
    if (this.refs.has(key)) throw new Error(`ref "${name}" is used twice.`)
    this.refs.set(key, id)
  }

  noteBoard(id: string): void {
    this.newBoards.add(id)
  }

  noteList(boardId: string, name: string, id: string): void {
    if (!this.newLists.has(boardId)) this.newLists.set(boardId, new Map())
    this.newLists.get(boardId)!.set(norm(name), id)
  }

  noteLabel(boardId: string, name: string, id: string): void {
    if (!this.newLabels.has(boardId)) this.newLabels.set(boardId, new Map())
    this.newLabels.get(boardId)!.set(norm(name), id)
  }

  noteCardLabels(cardId: string, labelIds: string[]): void {
    this.pendingLabels.set(cardId, labelIds)
  }

  /** A plain id parameter: an id, or a `$ref` from this batch. */
  id(value: string): string {
    const v = value.trim()
    if (isBatchRef(v)) {
      const id = this.refs.get(v)
      if (!id) {
        throw new Error(`Unknown ref ${v}: a ref is set by an earlier step's \`ref\`.`)
      }
      return id
    }
    return v
  }

  private ref(value: string): string | undefined {
    const v = value.trim()
    return isBatchRef(v) ? this.refs.get(v) : undefined
  }

  /** The board an argument names, or the batch default. */
  async board(ref: string | undefined): Promise<string | undefined> {
    const value = ref ?? this.defaultBoard
    if (value === undefined) return undefined
    const fromRef = this.ref(value)
    if (fromRef) return fromRef
    if (looksLikeId(value)) return value.trim()
    this.boardsCache ??= this.io.listBoards()
    return findBoard(await this.boardsCache, value)
  }

  private async needBoard(ref: string | undefined, what: string): Promise<string> {
    const id = await this.board(ref)
    if (id === undefined) {
      throw new Error(
        `${what} is looked up on a board: pass \`boardId\` (the board's id or name), or use the id.`
      )
    }
    return id
  }

  async view(boardId: string): Promise<BoardView | null> {
    if (this.newBoards.has(boardId)) return null
    if (!this.views.has(boardId)) this.views.set(boardId, this.io.boardView(boardId))
    return this.views.get(boardId)!
  }

  private async requireView(boardId: string): Promise<BoardView> {
    const view = await this.view(boardId)
    if (!view) throw new Error(`There is no board ${boardId}.`)
    return view
  }

  async cardView(id: string): Promise<CardView | null> {
    if (!this.cards.has(id)) this.cards.set(id, this.io.card(id))
    return this.cards.get(id)!
  }

  async card(ref: string, boardRef?: string): Promise<string> {
    const fromRef = this.ref(ref)
    if (fromRef) return fromRef
    if (isBatchRef(ref)) this.id(ref) // throws "unknown ref"
    const n = parseCardNumberRef(ref)
    if (n === null) return ref.trim()
    const boardId = await this.needBoard(boardRef, `"${ref}" is a card number, and numbers are per board, so it`)
    const view = await this.view(boardId)
    const inView = view ? findCardByNumber(view, n) : null
    if (inView) return inView.id
    // Archived cards aren't in the board view.
    const card = await this.io.card(ref, boardId)
    if (!card) throw new Error(`There is no card ${ref.trim()} on that board.`)
    return card.id
  }

  async list(ref: string, boardRef?: string): Promise<string> {
    const fromRef = this.ref(ref)
    if (fromRef) return fromRef
    if (looksLikeId(ref)) return ref.trim()
    const boardId = await this.needBoard(boardRef, `The list "${ref}"`)
    const made = this.newLists.get(boardId)?.get(norm(ref))
    if (made) return made
    return findList(await this.requireView(boardId), ref).id
  }

  async label(ref: string, boardRef?: string): Promise<string> {
    const fromRef = this.ref(ref)
    if (fromRef) return fromRef
    if (looksLikeId(ref)) return ref.trim()
    const boardId = await this.needBoard(boardRef, `The label "${ref}"`)
    const made = this.newLabels.get(boardId)?.get(norm(ref))
    if (made) return made
    return findLabel(await this.requireView(boardId), ref)
  }

  /** The board a card is on (for naming its labels without `boardId`). */
  async boardOfCard(cardId: string): Promise<string> {
    const card = await this.cardView(cardId)
    if (!card) throw new Error(`There is no card ${cardId}.`)
    return card.boardId
  }

  /** The card's label ids now, counting earlier steps of this batch. */
  async cardLabels(cardId: string): Promise<string[]> {
    const pending = this.pendingLabels.get(cardId)
    if (pending) return pending
    const card = await this.cardView(cardId)
    if (!card) throw new Error(`There is no card ${cardId}.`)
    return card.labelIds
  }
}
