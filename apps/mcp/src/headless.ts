import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import {
  AGENDA_COMPLETION_ACTIVITY_TYPES,
  MAX_VISIBLE_CARD_LIMIT,
  buildAgendaView,
  cardNumberNeedsBoardMessage,
  fillMissingCardNumbers,
  parseCardNumberRef,
  type AgendaCandidate,
  type AgendaOptions
} from '@kanbini/shared'
import type {
  ActivityView,
  AgendaView,
  ArchivedItemsView,
  AttachmentView,
  BoardBackground,
  BoardSummary,
  BoardView,
  BoardsListView,
  CardDensity,
  CardPriority,
  CardRef,
  CardRepeat,
  CardView,
  ChecklistView,
  CommentView,
  LabelView,
  ListOnEnterRule,
  ListSortMode,
  ListView,
  SearchHit,
  SearchHits,
  SwimlaneMode
} from '@kanbini/shared'

// Headless read-only fallback for MCP tools when the desktop app is
// closed. Parses the plain-text export at <userData>/export/ - the
// same snapshot the auto-export-on-quit writes - and exposes the read
// methods the control channel does (boards.list / board.getView /
// card.get / search.cards / agenda.get / board.archived) with byte-compatible view
// shapes.
//
// Drift risk: the view-builders in `@kanbini/db/data.ts` are the
// source of truth. If a future build adds a column or reshapes a view,
// the headless reader must keep up. The integration test in
// __tests__/headless.test.ts round-trips a populated DB through both
// paths and diffs their outputs, so divergence fails CI loudly.
//
// What the fallback CAN'T do: writes (no DB to mutate, no
// broadcastChange to fire - the AI gets a clear error telling it to
// open the app), and live freshness (the snapshot reflects the most
// recent app quit, which may be hours old).

// ─── on-disk shape ────────────────────────────────────────────────
// Mirrors the dump written by `@kanbini/db/export.ts`. We hand-narrow
// instead of importing zod here - the export is data we wrote
// ourselves, the format version is checked up-front, and pulling zod
// into the MCP bundle just for trusted-data validation isn't worth
// the bytes.

interface ExportDump {
  schemaVersion: number
  formatVersion: number
  exportedAt: number
  projects: Array<{ id: string; name: string }>
  boards: Array<{
    id: string
    projectId: string
    name: string
    description: string | null
    color: string | null
    background: unknown
    archived: boolean
    pinned: boolean
    position: string
    swimlaneMode: string | null
    /** The board's card number counter. Absent in exports written
     *  before numbers were per board; `loadHeadlessSnapshot` then
     *  renumbers their cards (same rule as the importer). */
    cardNumberLast?: number
    createdAt: number
    updatedAt: number
  }>
  lists: Array<{
    id: string
    boardId: string
    name: string
    color: string | null
    closed: boolean
    position: string
    wipLimit: number | null
    sortMode: string | null
    onEnter: unknown
    /** Absent in exports written before card density existed. */
    cardDensity?: string | null
    visibleCardLimit?: number | null
  }>
  cards: Array<{
    id: string
    /** Card number, per board. Absent in exports written before numbers
     *  existed, and from one counter shared by every board in exports
     *  written before they were per board; `loadHeadlessSnapshot`
     *  renumbers both (same rule as the importer). */
    number?: number | null
    listId: string
    title: string
    /** Always null in the dump - bodies live in cards/<id>.md and are
     *  stitched back by `loadHeadlessSnapshot`. */
    description: null
    position: string
    completed: boolean
    archived: boolean
    dueAt: number | null
    priority: string | null
    coverAttachmentId: string | null
    listAddedAt: number
    /** Absent in exports written before card density existed. */
    collapsed?: boolean | null
    /** Repeat rule JSON. Absent in exports written before it existed. */
    repeat?: unknown
    createdAt: number
    updatedAt: number
  }>
  labels: Array<{
    id: string
    boardId: string
    name: string
    color: string
  }>
  cardLabels: Array<{ cardId: string; labelId: string }>
  /** "Waiting on" links. Absent in exports written before they existed. */
  cardDependencies?: Array<{ cardId: string; blockerId: string; createdAt: number }>
  checklists: Array<{
    id: string
    cardId: string
    name: string
    position: string
  }>
  checklistItems: Array<{
    id: string
    checklistId: string
    text: string
    completed: boolean
    position: string
  }>
  comments: Array<{
    id: string
    cardId: string
    body: string
    author: string | null
    createdAt: number
    updatedAt: number
  }>
  attachments: Array<{
    id: string
    cardId: string
    filename: string
    relPath: string
    mime: string | null
    size: number | null
    sourceUrl: string | null
    sourceTitle: string | null
    createdAt: number
  }>
  activities: Array<{
    id: string
    boardId: string
    cardId: string | null
    type: string
    data: unknown
    createdAt: number
  }>
}

/** Max activity rows per card mirrored from `data.ts` ACTIVITY_FEED_LIMIT. */
const ACTIVITY_FEED_LIMIT = 30

/** Search snippet sizing mirrored from `@kanbini/db/search.ts` SNIPPET_MAX
 *  so headless hits read identically to live ones. */
const SNIPPET_MAX = 160
const SEARCH_HARD_LIMIT = 100
const SEARCH_DEFAULT_LIMIT = 50

export interface HeadlessSnapshot {
  exportedAt: number
  exportRoot: string
  dump: ExportDump
  /** cardId → stitched description text from cards/<id>.md. Cards
   *  with no description file are absent. */
  descriptions: Map<string, string>
}

/** Load a snapshot from the export root. Returns null if the export
 *  is missing entirely (the app has never run, or auto-export hasn't
 *  fired yet). Throws on corrupt JSON / unsupported format version -
 *  silently degrading to empty results would mislead the AI. */
export async function loadHeadlessSnapshot(
  exportRoot: string
): Promise<HeadlessSnapshot | null> {
  const jsonPath = join(exportRoot, 'kanbini.json')
  let raw: string
  try {
    raw = await fsp.readFile(jsonPath, 'utf8')
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return null
    throw e
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Export file isn't valid JSON: ${jsonPath}`)
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof (parsed as { formatVersion?: unknown }).formatVersion !== 'number'
  ) {
    throw new Error(`Export file isn't a Kanbini export: ${jsonPath}`)
  }
  const fv = (parsed as { formatVersion: number }).formatVersion
  if (fv !== 1) {
    throw new Error(
      `Export format version ${fv} isn't supported (built for 1).`
    )
  }
  const dump = parsed as ExportDump

  // Walk cards/ once and build the description map. Single directory
  // listing keeps subsequent per-card lookups O(1).
  const descriptions = new Map<string, string>()
  const cardsDir = join(exportRoot, 'cards')
  let entries: string[] = []
  try {
    entries = await fsp.readdir(cardsDir)
  } catch (e) {
    // No cards/ dir means no card had a description. Not an error.
    if ((e as { code?: string }).code !== 'ENOENT') throw e
  }
  for (const filename of entries) {
    if (!filename.endsWith('.md')) continue
    const cardId = filename.slice(0, -3)
    try {
      const body = await fsp.readFile(join(cardsDir, filename), 'utf8')
      if (body.length > 0) descriptions.set(cardId, body)
    } catch {
      /* skip unreadable files - better partial data than no data */
    }
  }

  // An export from before card numbers were per board: number its cards
  // the way importing it would (per board, creation order), so #N
  // lookups agree with the app.
  const numbers = fillMissingCardNumbers(dump)
  for (const c of dump.cards) c.number = numbers.get(c.id) ?? null

  return {
    exportedAt: dump.exportedAt ?? 0,
    exportRoot,
    dump,
    descriptions
  }
}

// ─── soft-narrow parsers (mirror @kanbini/db/data.ts) ────────────
// Future builds may add new enum values that this build doesn't
// know about; soft-narrowing to null keeps the AI's view valid
// rather than rejecting the whole response.

function parsePriority(p: string | null): CardPriority | null {
  return p === 'low' || p === 'medium' || p === 'high' || p === 'urgent'
    ? p
    : null
}

function parseSortMode(s: string | null): ListSortMode | null {
  switch (s) {
    case 'created-asc':
    case 'created-desc':
    case 'added-asc':
    case 'added-desc':
    case 'due-asc':
    case 'title-asc':
    case 'title-desc':
    case 'priority-desc':
      return s
    default:
      return null
  }
}

/** Mirror of `parseCardDensity` in @kanbini/db/data.ts. */
function parseCardDensity(s: string | null | undefined): CardDensity | null {
  return s === 'compact' ? s : null
}

/** Mirror of `parseVisibleCardLimit` in @kanbini/db/data.ts (same
 *  1..MAX_VISIBLE_CARD_LIMIT window). */
function parseVisibleCardLimit(n: number | null | undefined): number | null {
  return typeof n === 'number' &&
    Number.isInteger(n) &&
    n > 0 &&
    n <= MAX_VISIBLE_CARD_LIMIT
    ? n
    : null
}

/** Mirror of `parseRepeat` in @kanbini/db/repeat.ts. */
function parseRepeat(v: unknown): CardRepeat | null {
  if (v === null || typeof v !== 'object') return null
  const { unit, every } = v as { unit?: unknown; every?: unknown }
  const unitOk = unit === 'day' || unit === 'week' || unit === 'month' || unit === 'year'
  const everyOk =
    typeof every === 'number' && Number.isInteger(every) && every >= 1 && every <= 99
  return unitOk && everyOk ? { unit, every } : null
}

function parseSwimlaneMode(s: string | null): SwimlaneMode | null {
  return s === 'priority' ? s : null
}

function parseBackground(v: unknown): BoardBackground | null {
  if (v === null || typeof v !== 'object') return null
  const kind = (v as { kind?: unknown }).kind
  if (kind === 'color') {
    const value = (v as { value?: unknown }).value
    return typeof value === 'string' && value.length > 0
      ? { kind: 'color', value: value.slice(0, 64) }
      : null
  }
  if (kind === 'gradient') {
    const preset = (v as { preset?: unknown }).preset
    return typeof preset === 'string' && preset.length > 0
      ? { kind: 'gradient', preset: preset.slice(0, 48) }
      : null
  }
  if (kind === 'image') {
    const relPath = (v as { relPath?: unknown }).relPath
    return typeof relPath === 'string' && relPath.length > 0
      ? { kind: 'image', relPath: relPath.slice(0, 256) }
      : null
  }
  return null
}

function parseOnEnter(v: unknown): ListOnEnterRule | null {
  if (v === null || typeof v !== 'object') return null
  const kind = (v as { kind?: unknown }).kind
  if (kind === 'complete' || kind === 'uncomplete') return { kind }
  return null
}

// ─── string ordering ──────────────────────────────────────────────
// Fractional-index positions are plain strings; sort by code-point
// comparison matches SQLite's default. UUIDv7 ids likewise sort by
// time when compared as strings.
function strcmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// Priority severity rank for the priority-desc sort - mirrors the SQL
// CASE in data.ts `cardOrdering`. urgent first, unprioritised last.
function priorityRank(p: string | null): number {
  return p === 'urgent'
    ? 0
    : p === 'high'
      ? 1
      : p === 'medium'
        ? 2
        : p === 'low'
          ? 3
          : 4
}

/** The JS twin of data.ts `cardOrdering`: orders a list's cards by its
 *  sort mode. Both MUST produce the same order or the headless drift
 *  test fails. `toLowerCase()` matches SQLite's ASCII-only `lower()` for
 *  ASCII titles (what the suite uses); non-ASCII titles could order
 *  slightly differently in this offline fallback, an accepted edge. */
function compareCards(
  mode: ListSortMode | null,
  a: SortableCard,
  b: SortableCard
): number {
  switch (mode) {
    case 'created-desc':
      return a.createdAt !== b.createdAt
        ? b.createdAt - a.createdAt
        : strcmp(b.id, a.id)
    case 'created-asc':
      return a.createdAt !== b.createdAt
        ? a.createdAt - b.createdAt
        : strcmp(a.id, b.id)
    case 'added-desc':
      return a.listAddedAt !== b.listAddedAt
        ? b.listAddedAt - a.listAddedAt
        : strcmp(b.id, a.id)
    case 'added-asc':
      return a.listAddedAt !== b.listAddedAt
        ? a.listAddedAt - b.listAddedAt
        : strcmp(a.id, b.id)
    case 'due-asc': {
      // Soonest first; null (no due date) sinks to the bottom. The
      // null check narrows both operands to number for the subtraction.
      if (a.dueAt == null || b.dueAt == null) {
        if (a.dueAt === b.dueAt) return strcmp(a.id, b.id) // both null
        return a.dueAt == null ? 1 : -1
      }
      if (a.dueAt !== b.dueAt) return a.dueAt - b.dueAt
      return strcmp(a.id, b.id)
    }
    case 'title-asc': {
      const c = strcmp(a.title.toLowerCase(), b.title.toLowerCase())
      return c !== 0 ? c : strcmp(a.id, b.id)
    }
    case 'title-desc': {
      const c = strcmp(b.title.toLowerCase(), a.title.toLowerCase())
      return c !== 0 ? c : strcmp(b.id, a.id)
    }
    case 'priority-desc': {
      const r = priorityRank(a.priority) - priorityRank(b.priority)
      return r !== 0 ? r : strcmp(a.position, b.position)
    }
    default:
      return strcmp(a.position, b.position)
  }
}

/** The card fields `compareCards` reads (a structural subset of the
 *  dump card row). */
type SortableCard = {
  id: string
  title: string
  position: string
  dueAt: number | null
  priority: string | null
  createdAt: number
  listAddedAt: number
}

// ─── indexing helpers ─────────────────────────────────────────────
// Each per-request index is cheap but per-request rebuilds add up if
// a tool runs many lookups in a loop. Build once per call.

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>()
  for (const row of rows) {
    const k = key(row)
    const arr = out.get(k)
    if (arr) arr.push(row)
    else out.set(k, [row])
  }
  return out
}

// ─── headless implementations ─────────────────────────────────────

export function headlessListBoards(snap: HeadlessSnapshot): BoardsListView {
  const { dump } = snap

  // Same ORDER BY as listBoards: pinned desc, position asc.
  const sorted = [...dump.boards].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return strcmp(a.position, b.position)
  })

  const listsByBoard = groupBy(dump.lists, (l) => l.boardId)
  const cardsByList = groupBy(dump.cards, (c) => c.listId)
  const latestActivityByBoard = new Map<string, number>()
  for (const a of dump.activities) {
    const cur = latestActivityByBoard.get(a.boardId) ?? 0
    if (a.createdAt > cur) latestActivityByBoard.set(a.boardId, a.createdAt)
  }

  return sorted.map((b): BoardSummary => {
    const lists = listsByBoard.get(b.id) ?? []
    const openLists = lists.filter((l) => !l.closed)
    let cardCount = 0
    for (const l of openLists) {
      for (const c of cardsByList.get(l.id) ?? []) {
        if (!c.archived) cardCount += 1
      }
    }
    return {
      id: b.id,
      projectId: b.projectId,
      name: b.name,
      description: b.description,
      color: b.color,
      background: parseBackground(b.background),
      archived: b.archived,
      pinned: b.pinned,
      position: b.position,
      listCount: openLists.length,
      cardCount,
      createdAt: b.createdAt,
      updatedAt: Math.max(b.updatedAt, latestActivityByBoard.get(b.id) ?? 0)
    }
  })
}

export function headlessBoardView(
  snap: HeadlessSnapshot,
  boardId?: string
): BoardView | null {
  const { dump } = snap
  // Mirror getBoardView: explicit id wins; otherwise first board by
  // position ascending.
  const b = boardId
    ? dump.boards.find((x) => x.id === boardId)
    : [...dump.boards].sort((a, b) => strcmp(a.position, b.position))[0]
  if (!b) return null
  const p = dump.projects.find((x) => x.id === b.projectId)
  if (!p) return null

  // Creation order (UUIDv7 id), matching getBoardView's `asc(label.id)`
  // so the headless fallback stays byte-compatible with the live view.
  const labelsForBoard = dump.labels
    .filter((l) => l.boardId === b.id)
    .sort((a, b) => strcmp(a.id, b.id))

  const listsForBoard = dump.lists
    .filter((l) => l.boardId === b.id)
    .sort((a, b) => strcmp(a.position, b.position))

  // Archived cards are hidden, matching getBoardView's
  // `card.archived = false` filter (closed lists stay, flagged).
  const cardsByList = groupBy(
    dump.cards.filter((c) => !c.archived),
    (c) => c.listId
  )
  const labelIdsByCard = groupBy(dump.cardLabels, (cl) => cl.cardId)
  const checklistsByCard = groupBy(dump.checklists, (cl) => cl.cardId)
  const itemsByChecklist = groupBy(
    dump.checklistItems,
    (it) => it.checklistId
  )
  const commentsByCard = groupBy(dump.comments, (cm) => cm.cardId)
  const attachmentsByCard = groupBy(dump.attachments, (at) => at.cardId)
  const activitiesByCard = new Map<string, ExportDump['activities']>()
  for (const a of dump.activities) {
    if (a.cardId === null) continue
    const arr = activitiesByCard.get(a.cardId)
    if (arr) arr.push(a)
    else activitiesByCard.set(a.cardId, [a])
  }
  const deps = dependencyIndex(dump)

  const lists: ListView[] = listsForBoard.map((l) => {
    const sortMode = parseSortMode(l.sortMode)
    const cardRows = cardsByList.get(l.id) ?? []
    const orderedCards = [...cardRows].sort((a, b) =>
      compareCards(sortMode, a, b)
    )

    const cards: CardView[] = orderedCards.map((c) =>
      buildCardView(c, snap, {
        labelIdsByCard,
        checklistsByCard,
        itemsByChecklist,
        commentsByCard,
        attachmentsByCard,
        activitiesByCard,
        deps
      })
    )

    return {
      id: l.id,
      name: l.name,
      color: l.color,
      closed: l.closed,
      position: l.position,
      wipLimit: l.wipLimit,
      sortMode,
      onEnter: parseOnEnter(l.onEnter),
      cardDensity: parseCardDensity(l.cardDensity),
      visibleCardLimit: parseVisibleCardLimit(l.visibleCardLimit),
      cards
    }
  })

  const viewLabels: LabelView[] = labelsForBoard.map((l) => ({
    id: l.id,
    name: l.name,
    color: l.color
  }))

  return {
    project: { id: p.id, name: p.name },
    board: {
      id: b.id,
      name: b.name,
      color: b.color,
      background: parseBackground(b.background),
      swimlaneMode: parseSwimlaneMode(b.swimlaneMode)
    },
    labels: viewLabels,
    lists
  }
}

/** Mirror of `getArchivedItems` (@kanbini/db/data.ts): closed lists by
 *  position (id tiebreak), archived cards by updatedAt desc (id desc
 *  tiebreak). Pinned against the live read by the parity suite. */
export function headlessArchivedItems(
  snap: HeadlessSnapshot,
  boardId: string
): ArchivedItemsView | null {
  const { dump } = snap
  if (!dump.boards.some((b) => b.id === boardId)) return null

  const lists = dump.lists
    .filter((l) => l.boardId === boardId)
    .sort((a, b) => strcmp(a.position, b.position) || strcmp(a.id, b.id))
  const listById = new Map(lists.map((l) => [l.id, l]))

  const liveCounts = new Map<string, number>()
  const archived: ExportDump['cards'] = []
  for (const c of dump.cards) {
    if (!listById.has(c.listId)) continue
    if (c.archived) archived.push(c)
    else liveCounts.set(c.listId, (liveCounts.get(c.listId) ?? 0) + 1)
  }
  archived.sort((a, b) => b.updatedAt - a.updatedAt || strcmp(b.id, a.id))

  return {
    boardId,
    lists: lists
      .filter((l) => l.closed)
      .map((l) => ({
        id: l.id,
        name: l.name,
        color: l.color,
        cardCount: liveCounts.get(l.id) ?? 0
      })),
    cards: archived.map((c) => {
      const l = listById.get(c.listId)
      return {
        id: c.id,
        title: c.title,
        listId: c.listId,
        listName: l?.name ?? '',
        listClosed: l?.closed ?? false,
        updatedAt: c.updatedAt
      }
    })
  }
}

/** Mirror of `getCardView`: `ref` is the card's id, or its number
 *  (#142 / 142) with `boardId` - a number without one throws, naming the
 *  boards that have it (see `resolveCardRef` in @kanbini/db/data.ts). */
export function headlessCardView(
  snap: HeadlessSnapshot,
  ref: string,
  boardId?: string
): CardView | null {
  const n = parseCardNumberRef(ref)
  const boardOfList = new Map(snap.dump.lists.map((l) => [l.id, l.boardId]))
  if (n !== null && boardId === undefined) {
    const withNumber = new Set(
      snap.dump.cards.filter((x) => x.number === n).map((x) => boardOfList.get(x.listId))
    )
    const boards = snap.dump.boards
      .filter((b) => withNumber.has(b.id))
      .sort((a, b) => strcmp(a.position, b.position) || strcmp(a.id, b.id))
    throw new Error(cardNumberNeedsBoardMessage(n, boards))
  }
  const c = snap.dump.cards.find((x) =>
    n === null ? x.id === ref : x.number === n && boardOfList.get(x.listId) === boardId
  )
  if (!c) return null
  return buildCardView(c, snap, {
    labelIdsByCard: groupBy(snap.dump.cardLabels, (cl) => cl.cardId),
    checklistsByCard: groupBy(snap.dump.checklists, (cl) => cl.cardId),
    itemsByChecklist: groupBy(snap.dump.checklistItems, (it) => it.checklistId),
    commentsByCard: groupBy(snap.dump.comments, (cm) => cm.cardId),
    attachmentsByCard: groupBy(snap.dump.attachments, (at) => at.cardId),
    activitiesByCard: groupActivitiesByCard(snap.dump.activities),
    deps: dependencyIndex(snap.dump)
  })
}

/** Mirror of `dependencyRefs` in @kanbini/db/dependencies.ts: both
 *  directions per card, oldest link first, the far end's id breaking
 *  ties. A link whose far end is missing from the dump is skipped, as
 *  the live INNER JOIN would. */
function dependencyIndex(dump: ExportDump): {
  blockedBy: Map<string, CardRef[]>
  blocking: Map<string, CardRef[]>
} {
  const cardsById = new Map(dump.cards.map((c) => [c.id, c]))
  const listsById = new Map(dump.lists.map((l) => [l.id, l]))
  const boardsById = new Map(dump.boards.map((b) => [b.id, b]))
  const refOf = (id: string): CardRef | null => {
    const c = cardsById.get(id)
    const l = c && listsById.get(c.listId)
    const b = l && boardsById.get(l.boardId)
    if (!c || !l || !b) return null
    return {
      cardId: c.id,
      title: c.title,
      completed: c.completed,
      archived: c.archived,
      boardId: b.id,
      boardName: b.name,
      listName: l.name
    }
  }
  const edges = dump.cardDependencies ?? []
  const build = (
    near: (e: (typeof edges)[number]) => string,
    far: (e: (typeof edges)[number]) => string
  ): Map<string, CardRef[]> => {
    const out = new Map<string, CardRef[]>()
    const sorted = [...edges].sort(
      (a, b) => a.createdAt - b.createdAt || strcmp(far(a), far(b))
    )
    for (const e of sorted) {
      const ref = refOf(far(e))
      if (!ref) continue
      const arr = out.get(near(e))
      if (arr) arr.push(ref)
      else out.set(near(e), [ref])
    }
    return out
  }
  return {
    blockedBy: build((e) => e.cardId, (e) => e.blockerId),
    blocking: build((e) => e.blockerId, (e) => e.cardId)
  }
}

function groupActivitiesByCard(
  activities: ExportDump['activities']
): Map<string, ExportDump['activities']> {
  const out = new Map<string, ExportDump['activities']>()
  for (const a of activities) {
    if (a.cardId === null) continue
    const arr = out.get(a.cardId)
    if (arr) arr.push(a)
    else out.set(a.cardId, [a])
  }
  return out
}

interface CardIndexes {
  labelIdsByCard: Map<string, Array<{ cardId: string; labelId: string }>>
  checklistsByCard: Map<string, ExportDump['checklists']>
  itemsByChecklist: Map<string, ExportDump['checklistItems']>
  commentsByCard: Map<string, ExportDump['comments']>
  attachmentsByCard: Map<string, ExportDump['attachments']>
  activitiesByCard: Map<string, ExportDump['activities']>
  deps: ReturnType<typeof dependencyIndex>
}

function buildCardView(
  c: ExportDump['cards'][number],
  snap: HeadlessSnapshot,
  idx: CardIndexes
): CardView {
  const labelIds = (idx.labelIdsByCard.get(c.id) ?? []).map((r) => r.labelId)

  const attachments: AttachmentView[] = [
    ...(idx.attachmentsByCard.get(c.id) ?? [])
  ]
    .sort((a, b) => a.createdAt - b.createdAt)
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

  const comments: CommentView[] = [
    ...(idx.commentsByCard.get(c.id) ?? [])
  ]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((cm) => ({
      id: cm.id,
      body: cm.body,
      author: cm.author,
      createdAt: cm.createdAt,
      updatedAt: cm.updatedAt
    }))

  const checklists: ChecklistView[] = [
    ...(idx.checklistsByCard.get(c.id) ?? [])
  ]
    .sort((a, b) => strcmp(a.position, b.position))
    .map((cl) => ({
      id: cl.id,
      name: cl.name,
      position: cl.position,
      items: [...(idx.itemsByChecklist.get(cl.id) ?? [])]
        .sort((a, b) => strcmp(a.position, b.position))
        .map((it) => ({
          id: it.id,
          text: it.text,
          completed: it.completed,
          position: it.position
        }))
    }))

  // Activity feed: most recent first, capped, id as the same-ms
  // tiebreaker (UUIDv7 is time-sorted as a string).
  const activities: ActivityView[] = [
    ...(idx.activitiesByCard.get(c.id) ?? [])
  ]
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt
      return strcmp(b.id, a.id)
    })
    .slice(0, ACTIVITY_FEED_LIMIT)
    .map((a) => ({
      id: a.id,
      cardId: a.cardId,
      type: a.type,
      data: a.data,
      createdAt: a.createdAt
    }))

  return {
    id: c.id,
    number: c.number ?? 0,
    title: c.title,
    description: snap.descriptions.get(c.id) ?? null,
    position: c.position,
    completed: c.completed,
    dueAt: c.dueAt,
    priority: parsePriority(c.priority),
    repeat: parseRepeat(c.repeat),
    collapsed: c.collapsed ?? null,
    labelIds,
    checklists,
    comments,
    attachments,
    coverAttachmentId: c.coverAttachmentId,
    activities,
    blockedBy: idx.deps.blockedBy.get(c.id) ?? [],
    blocking: idx.deps.blocking.get(c.id) ?? []
  }
}

export function headlessSearchCards(
  snap: HeadlessSnapshot,
  query: string,
  limit: number = SEARCH_DEFAULT_LIMIT
): SearchHits {
  const { dump } = snap
  const q = query.trim().toLowerCase()
  if (q.length === 0) return []
  const cap = Math.min(Math.max(1, limit), SEARCH_HARD_LIMIT)
  const asNumber = parseCardNumberRef(q)

  // Indexes for resolving each hit's surrounding context.
  const labelsById = new Map<string, ExportDump['labels'][number]>()
  for (const l of dump.labels) labelsById.set(l.id, l)
  const labelIdsByCard = groupBy(dump.cardLabels, (cl) => cl.cardId)
  const listsById = new Map<string, ExportDump['lists'][number]>()
  for (const l of dump.lists) listsById.set(l.id, l)
  const boardsById = new Map<string, ExportDump['boards'][number]>()
  for (const b of dump.boards) boardsById.set(b.id, b)

  // Mirror the live searchCards filters: skip archived cards, cards
  // whose list is closed, and cards on archived boards.
  const candidates = dump.cards.filter((c) => {
    if (c.archived) return false
    const l = listsById.get(c.listId)
    if (!l || l.closed) return false
    const b = boardsById.get(l.boardId)
    if (!b || b.archived) return false
    return true
  })

  const hits: SearchHit[] = []

  for (const c of candidates) {
    const list = listsById.get(c.listId)!
    const board = boardsById.get(list.boardId)
    if (!board) continue

    const numberHit = asNumber !== null && c.number === asNumber
    const titleHit = c.title.toLowerCase().includes(q)
    const cardLabelRows = labelIdsByCard.get(c.id) ?? []
    const cardLabels = cardLabelRows
      .map((cl) => labelsById.get(cl.labelId))
      .filter((l): l is NonNullable<typeof l> => l !== undefined)
    const labelHits = cardLabels.filter((l) =>
      l.name.toLowerCase().includes(q)
    )
    const description = snap.descriptions.get(c.id) ?? null
    const descriptionHit =
      description !== null && description.toLowerCase().includes(q)

    if (!numberHit && !titleHit && labelHits.length === 0 && !descriptionHit) continue

    // Strongest-tier wins. Same precedence as live searchCards:
    // number > title > label > description.
    const matchKind: SearchHit['matchKind'] = numberHit
      ? 'number'
      : titleHit
        ? 'title'
        : labelHits.length > 0
          ? 'label'
          : 'description'

    // Snippet is attached whenever the description matched, regardless
    // of which tier won - same as the live implementation.
    const descriptionSnippet =
      descriptionHit && description !== null
        ? snippetAround(description, q)
        : null

    hits.push({
      cardId: c.id,
      number: c.number ?? 0,
      title: c.title,
      descriptionSnippet,
      boardId: board.id,
      boardName: board.name,
      listName: list.name,
      matchedLabels: labelHits.map((l) => l.name),
      matchKind,
      updatedAt: c.updatedAt
    })
  }

  const tier = { number: 0, title: 1, label: 2, description: 3 } as const
  hits.sort((a, b) => {
    const t = tier[a.matchKind] - tier[b.matchKind]
    if (t !== 0) return t
    return b.updatedAt - a.updatedAt
  })
  return hits.slice(0, cap)
}

/** Mirror of `getAgenda` in `@kanbini/db/agenda.ts`. The section rules
 *  and ordering are the SAME function (`buildAgendaView`), so this only
 *  has to gather the same candidates: every open-list card on a
 *  non-archived board that isn't archived, with its newest completion
 *  activity as `completedAt`. buildAgendaView drops the ones that fit no
 *  section, so no pre-filtering on dates is needed here. */
export function headlessAgenda(
  snap: HeadlessSnapshot,
  opts: AgendaOptions = {}
): AgendaView {
  const { dump } = snap
  const listsById = new Map<string, ExportDump['lists'][number]>()
  for (const l of dump.lists) listsById.set(l.id, l)
  const boardsById = new Map<string, ExportDump['boards'][number]>()
  for (const b of dump.boards) boardsById.set(b.id, b)

  const completionTypes: readonly string[] = AGENDA_COMPLETION_ACTIVITY_TYPES
  const lastCompleted = new Map<string, number>()
  for (const a of dump.activities) {
    if (a.cardId === null || !completionTypes.includes(a.type)) continue
    const prev = lastCompleted.get(a.cardId)
    if (prev === undefined || a.createdAt > prev) {
      lastCompleted.set(a.cardId, a.createdAt)
    }
  }

  // Mirror of the live EXISTS: waiting on any card that's still open.
  const cardsById = new Map(dump.cards.map((c) => [c.id, c]))
  const blocked = new Set<string>()
  for (const e of dump.cardDependencies ?? []) {
    const blocker = cardsById.get(e.blockerId)
    if (blocker && !blocker.completed && !blocker.archived) blocked.add(e.cardId)
  }

  const candidates: AgendaCandidate[] = []
  for (const c of dump.cards) {
    if (c.archived) continue
    const l = listsById.get(c.listId)
    if (!l || l.closed) continue
    const b = boardsById.get(l.boardId)
    if (!b || b.archived) continue
    candidates.push({
      cardId: c.id,
      title: c.title,
      boardId: b.id,
      boardName: b.name,
      boardColor: b.color,
      listId: l.id,
      listName: l.name,
      dueAt: c.dueAt,
      priority: parsePriority(c.priority),
      completed: c.completed,
      completedAt: lastCompleted.get(c.id) ?? null,
      blocked: blocked.has(c.id)
    })
  }
  return buildAgendaView(candidates, opts)
}

/** Mirrors `snippetAround` in `@kanbini/db/search.ts` - centered window
 *  of SNIPPET_MAX chars around the match site, with ellipses on
 *  truncated ends so the user sees why a hit surfaced. */
function snippetAround(text: string, qLower: string): string {
  const i = text.toLowerCase().indexOf(qLower)
  if (i < 0 || text.length <= SNIPPET_MAX) return text.slice(0, SNIPPET_MAX)
  const half = Math.floor((SNIPPET_MAX - qLower.length) / 2)
  const start = Math.max(0, i - half)
  const end = Math.min(text.length, start + SNIPPET_MAX)
  return (
    (start > 0 ? '…' : '') +
    text.slice(start, end) +
    (end < text.length ? '…' : '')
  )
}
