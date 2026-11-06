import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  APP_CODENAME,
  AGENDA_MAX_DAYS,
  MAX_MUTATION_BATCH as MAX_BATCH_MUTATIONS,
  type BoardView,
  type BoardsListView,
  type CardView,
  type Mutation,
  type MutationResult
} from '@kanbini/shared'
import {
  headlessAgenda,
  headlessArchivedItems,
  headlessBoardView,
  headlessCardView,
  headlessListBoards,
  headlessSearchCards,
  loadHeadlessSnapshot,
  type HeadlessSnapshot
} from './headless.js'
import { CARD_REF_HINT, OPS, OPS_BY_NAME } from './ops.js'
import { Resolver, findBoard, findLabel, findList, looksLikeId, type ResolverIO } from './refs.js'
import {
  filterCards,
  labelNameMap,
  nextLocalDay,
  parseLocalDate,
  summarizeBoard,
  summarizeCard
} from './summary.js'

// @kanbini/mcp - stdio MCP server (M3-B + M3-tail). Claude Desktop /
// Claude Code launch this process, hand it the MCP protocol over
// stdio, and call our tools. Each tool POSTs to the desktop app's
// control channel (M3-A) using the bearer token from
// `<userData>/mcp.json`.
//
// Read tools: kanbini_list_boards, kanbini_get_board, kanbini_get_card,
//   kanbini_search_cards, kanbini_get_agenda, kanbini_list_archived (all
//   with the headless export fallback when the app is closed).
// Write tools: create / update / move / delete / archive cards; create /
//   update / move / archive lists (incl. WIP limit, sort mode, colour,
//   on-enter rule); create / update / archive boards; create / rename /
//   recolour / delete labels and set them on cards; add / remove
//   "waiting on" links between cards; post AI-authored
//   comments; manage checklists; add and delete attachments. Every
//   successful write triggers main's broadcastChange, so an open
//   renderer reflects AI edits live.

// ─── userData discovery ──────────────────────────────────────────
// Replicate Electron's `app.getPath('userData')` for the same
// APP_CODENAME so we land on the exact directory the running app
// wrote its mcp.json to.
//
// `KANBINI_USERDATA_OVERRIDE` (when set, must be the FULL path
// including the APP_CODENAME segment) short-circuits the platform
// resolution. Used by the in-process integration tests in
// `apps/mcp/src/__tests__` so they can stand up a fake control
// channel in a temp dir without writing into the user's real
// userData and conflicting with a running desktop app.
function userDataDir(): string {
  const override = process.env['KANBINI_USERDATA_OVERRIDE']
  if (override) return override
  if (process.platform === 'win32') {
    const appData =
      process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming')
    return join(appData, APP_CODENAME)
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', APP_CODENAME)
  }
  // linux + everything else: XDG_CONFIG_HOME or ~/.config
  const xdg = process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config')
  return join(xdg, APP_CODENAME)
}

// ─── control channel discovery ───────────────────────────────────
const zDiscovery = z.object({
  port: z.number().int().positive(),
  token: z.string().min(1),
  pid: z.number().int().positive()
})
type Discovery = z.infer<typeof zDiscovery>

async function loadDiscovery(): Promise<Discovery | null> {
  const path = join(userDataDir(), 'mcp.json')
  try {
    const text = await fsp.readFile(path, 'utf8')
    return zDiscovery.parse(JSON.parse(text))
  } catch {
    return null
  }
}

// ─── RPC client ──────────────────────────────────────────────────
class AppOfflineError extends Error {
  constructor() {
    super(
      'Kanbini desktop app is not running. Reads fall back to the ' +
        'last on-disk export when one exists; writes need the app open.'
    )
  }
}

/** A deterministic response from the control channel (auth failure or an
 *  application-level error status). Distinct from a connection-level
 *  failure so `rpc` knows NOT to retry it and NOT to mask it as the app
 *  being offline - retrying a 401 or a validation error just fails the
 *  same way, and reporting it as "app offline" would be misleading. */
class ControlChannelError extends Error {}

async function rpc(method: string, params: unknown): Promise<unknown> {
  const info = await loadDiscovery()
  if (!info) throw new AppOfflineError()

  // One logical attempt: send the request, check the status, parse the
  // body. Throws a ControlChannelError for deterministic failures (do
  // not retry) and a plain connection error otherwise (retryable).
  const attempt = async (): Promise<unknown> => {
    const res = await fetch(`http://127.0.0.1:${info.port}/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${info.token}`
      },
      body: JSON.stringify({ method, params })
    })
    if (res.status === 401) {
      throw new ControlChannelError(
        'control channel rejected the bearer token (401). Restart the ' +
          'Kanbini desktop app to refresh <userData>/mcp.json, then retry.'
      )
    }
    if (!res.ok) {
      let detail = `HTTP ${res.status}`
      try {
        const body = (await res.json()) as { error?: string }
        if (body?.error) detail += `: ${body.error}`
      } catch {
        /* non-JSON error body */
      }
      throw new ControlChannelError(`control channel: ${detail}`)
    }
    return res.json()
  }

  try {
    return await attempt()
  } catch (e) {
    // Deterministic channel responses surface as-is.
    if (e instanceof ControlChannelError) throw e
    // Connection-level failure. The #1 cause is NOT the app being down -
    // it's a stale keep-alive socket: Node's global fetch pools
    // connections, and if the control-channel server closed an idle one
    // a beat before this fetch reused it, the request lands on a dead
    // socket (ECONNRESET). Retry ONCE on a fresh socket before
    // concluding the app is offline - this is what fixes the
    // intermittent "tool use error" right after a successful call.
    try {
      return await attempt()
    } catch (e2) {
      if (e2 instanceof ControlChannelError) throw e2
      // Both attempts hit a connection error: the app really is down
      // (ECONNREFUSED) or otherwise unreachable.
      throw new AppOfflineError()
    }
  }
}

// ─── headless read-only fallback ─────────────────────────────────
// When the desktop app is closed, read tools fall back to the
// plain-text export the desktop auto-writes on quit
// (<userData>/export/, see ADR-0019). Writes don't fall back - they
// surface AppOfflineError so the AI can tell the user to open the app.
//
// `loadHeadlessSnapshot` is called per-request (rather than cached
// across the MCP process lifetime) so freshness ties to the snapshot
// on disk: if the user opens + closes the app between two read tool
// calls, the second one picks up the newer export automatically.

function exportRootPath(): string {
  return join(userDataDir(), 'export')
}

type HeadlessRead = (snap: HeadlessSnapshot) => unknown

interface ReadResult {
  data: unknown
  source: 'app' | 'export'
  /** Only populated when source === 'export'. */
  exportedAt?: number
}

/** Run a read against the running app first; on AppOfflineError, fall
 *  back to the on-disk export snapshot. The four read methods supply
 *  their own snapshot reader so we don't reflect on the method name
 *  here. */
async function readWithFallback(
  liveMethod: string,
  params: unknown,
  fromExport: HeadlessRead
): Promise<ReadResult> {
  try {
    const data = await rpc(liveMethod, params)
    return { data, source: 'app' }
  } catch (e) {
    if (!(e instanceof AppOfflineError)) throw e
    const snap = await loadHeadlessSnapshot(exportRootPath())
    if (!snap) {
      throw new Error(
        'Kanbini desktop app is not running, and no on-disk export ' +
          'was found at ' +
          exportRootPath() +
          '. Open the desktop app once to create one, then retry.'
      )
    }
    return {
      data: fromExport(snap),
      source: 'export',
      exportedAt: snap.exportedAt
    }
  }
}

// ─── tool handler helpers ────────────────────────────────────────
// MCP tool callbacks return `{ content: [{ type: 'text', text }],
// isError?: boolean }`. Wrap rpc calls so any thrown error surfaces
// as a structured tool error (Claude shows the text to the user)
// rather than crashing the stdio loop.
async function asToolResult<T>(
  fn: () => Promise<T>
): Promise<{
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}> {
  try {
    const result = await fn()
    return {
      // Compact JSON: the AI reads it just as well, in fewer tokens.
      content: [{ type: 'text', text: JSON.stringify(result) }]
    }
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e)
    return { content: [{ type: 'text', text }], isError: true }
  }
}

/** Variant of `asToolResult` for the four read tools - accepts the
 *  `{ data, source, exportedAt }` shape returned by `readWithFallback`
 *  and prefixes the JSON with a one-line notice when the result came
 *  from the on-disk snapshot. The notice tells the AI two things the
 *  caller cares about: (1) this isn't live data, and (2) writes won't
 *  work until the desktop app is reopened. */
async function asReadToolResult(
  fn: () => Promise<ReadResult>
): Promise<{
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}> {
  try {
    const { data, source, exportedAt } = await fn()
    let text = JSON.stringify(data)
    if (source === 'export') {
      const when = exportedAt
        ? new Date(exportedAt).toISOString()
        : 'unknown'
      text =
        `[NOTE] Kanbini desktop app is closed. Reading from the ` +
        `last on-disk export (snapshot from ${when}). Writes need ` +
        `the app open.\n\n` +
        text
    }
    return { content: [{ type: 'text', text }] }
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e)
    return { content: [{ type: 'text', text }], isError: true }
  }
}

// ─── server bootstrap ────────────────────────────────────────────
// __KANBINI_VERSION__ is inlined by tsup's `define` from the desktop
// app's package.json (the release-bumped one), so the reported version
// can't drift from the product again. The typeof guard keeps direct
// src execution (vitest importing this file un-bundled) from crashing.
declare const __KANBINI_VERSION__: string
const SERVER_VERSION =
  typeof __KANBINI_VERSION__ !== 'undefined' ? __KANBINI_VERSION__ : '0.0.0-dev'

const server = new McpServer({
  name: 'kanbini',
  version: SERVER_VERSION
})

server.registerTool(
  'kanbini_list_boards',
  {
    title: 'List Kanbini boards',
    description:
      'Enumerate every board in the database with id, name, description, ' +
      'archived flag, list/card counts, and updatedAt (epoch ms; blends ' +
      "the board's own timestamp with the most recent activity-log entry " +
      'for it, so the array sorts by real recency). Use this first to ' +
      'discover boardIds before calling kanbini_get_board. Returns [] if ' +
      'no boards exist. When the desktop app is closed, falls back to ' +
      "the last on-disk export and prefixes the response with a notice.",
    inputSchema: {}
  },
  () =>
    asReadToolResult(() =>
      readWithFallback('boards.list', {}, (snap) => headlessListBoards(snap))
    )
)

server.registerTool(
  'kanbini_get_board',
  {
    title: 'Get Kanbini board',
    description:
      'Return one board: its labels, and every list with its cards. By default (`detail: ' +
      '"summary"`) each card is one short line: `number` (the #N shown on the card, counted per ' +
      'board), `title`, and only what applies: `completed`, `due` (YYYY-MM-DD), `priority`, ' +
      '`labels` (names), `checklist` ("ticked/total"), `description: true` when it has one, ' +
      '`comments` / `attachments` counts, `blocked` (waiting on an open card), `repeat`. A list ' +
      'shows its first `cardsPerList` cards (default 50, in board order); a longer one says how ' +
      'many it left out in `moreCards`, and kanbini_get_list_cards filters or pages through them. ' +
      'Cards ' +
      'are named by number: pass `#142` with this boardId to any tool that takes a card, and use ' +
      'kanbini_get_card for its description, checklists, comments and history. For one list, ' +
      'filtered (open / done, label, priority, due, text) or paged, use kanbini_get_list_cards. ' +
      '`detail: "full"` returns every card with all of its content, which is very large on a big ' +
      'board: avoid it. Archived cards are left out; archived lists show `closed: true` with no ' +
      "cards (kanbini_list_archived lists both). A list's `visibleCardLimit` / `cardDensity` and " +
      "a card's `collapsed` are display settings only: every card is still returned. `boardId` " +
      'is the id or exact name; omitted, the first board. Returns null if it matches nothing. ' +
      'When the desktop app is closed, falls back to the last on-disk export.',
    inputSchema: {
      boardId: z.string().optional(),
      detail: z.enum(['summary', 'full']).optional(),
      cardsPerList: z.number().int().positive().max(1000).optional()
    }
  },
  ({ boardId, detail, cardsPerList }) =>
    asReadToolResult(async () => {
      const id = boardId === undefined ? undefined : await readBoardId(boardId)
      const read = await readWithFallback(
        'board.getView',
        id !== undefined ? { boardId: id } : {},
        (snap) => headlessBoardView(snap, id)
      )
      const view = read.data as BoardView | null
      return detail === 'full' || !view
        ? read
        : { ...read, data: summarizeBoard(view, cardsPerList) }
    })
)

server.registerTool(
  'kanbini_get_list_cards',
  {
    title: "Get a list's cards",
    description:
      "One list's cards, optionally filtered and paged. `listId` is the list's id or exact name, " +
      'on `boardId` (id or name). Filters, all optional and combined: `status` "open" | ' +
      '"completed" | "all" (default); `label` (name or id) the card carries; `priority` ' +
      '(low/medium/high/urgent, or "none"); `dueFrom` / `dueTo` (YYYY-MM-DD, inclusive; a card ' +
      'without a due date never matches them); `hasDue` true/false; `query` (text in the title ' +
      'or description, any case). Returns { boardId, list: { id, name, cardCount }, matched ' +
      '(cards matching the filters), offset, cards, more (true when another page follows: ' +
      'call again with offset + cards.length) }. Cards come in the order the list shows them, as ' +
      'the same one-line summaries kanbini_get_board gives; `detail: "full"` returns them with ' +
      'all of their content (descriptions, checklists, comments, history). `limit` defaults to ' +
      '50, max 200. Good for "what is still open in To Do", "every Bug card", or walking a long ' +
      'list page by page. When the desktop app is closed, falls back to the last on-disk export.',
    inputSchema: {
      boardId: z.string(),
      listId: z.string(),
      status: z.enum(['open', 'completed', 'all']).optional(),
      label: z.string().optional(),
      priority: z.enum(['low', 'medium', 'high', 'urgent', 'none']).optional(),
      dueFrom: z.string().optional(),
      dueTo: z.string().optional(),
      hasDue: z.boolean().optional(),
      query: z.string().optional(),
      limit: z.number().int().positive().max(200).optional(),
      offset: z.number().int().min(0).optional(),
      detail: z.enum(['summary', 'full']).optional()
    }
  },
  (args) =>
    asReadToolResult(async () => {
      const boardId = await readBoardId(args.boardId)
      const read = await readWithFallback('board.getView', { boardId }, (snap) =>
        headlessBoardView(snap, boardId)
      )
      const view = read.data as BoardView | null
      if (!view) throw new Error(`There is no board ${args.boardId}.`)
      const list = findList(view, args.listId)
      const matched = filterCards(list.cards, {
        status: args.status,
        labelId: args.label !== undefined ? findLabel(view, args.label) : undefined,
        priority: args.priority,
        dueFrom: args.dueFrom !== undefined ? parseLocalDate(args.dueFrom) : undefined,
        // Inclusive: anything due before the NEXT day's midnight.
        dueTo:
          args.dueTo !== undefined ? nextLocalDay(parseLocalDate(args.dueTo)) - 1 : undefined,
        hasDue: args.hasDue,
        query: args.query
      })
      const offset = args.offset ?? 0
      const page = matched.slice(offset, offset + (args.limit ?? 50))
      const names = labelNameMap(view)
      return {
        ...read,
        data: {
          boardId: view.board.id,
          list: { id: list.id, name: list.name, cardCount: list.cards.length },
          matched: matched.length,
          offset,
          cards: args.detail === 'full' ? page : page.map((c) => summarizeCard(c, names)),
          ...(offset + page.length < matched.length ? { more: true } : {})
        }
      }
    })
)

server.registerTool(
  'kanbini_get_card',
  {
    title: 'Get Kanbini card',
    description:
      'Return one Kanbini card by id OR by its number - `#142` or `142`, the short #N the app ' +
      'shows on the card, which is how the user refers to cards. Numbers are counted per board, ' +
      'so a number needs its `boardId` (the id or name of the board the user means; without one ' +
      'this errors and lists the boards that have that number). Numbers handed out before they ' +
      'were per board are gone: look a card up again rather than trusting an old number. ' +
      '`boardId` is ignored for an id. Includes its `id`, `number` and `boardId` (keep the number ' +
      'and board together), title, description, priority (low/medium/high/urgent or null), ' +
      'checklists (with item ids), comments, attachments, recent activity feed, and its "waiting ' +
      'on" links: `blockedBy` (cards it waits on) and `blocking` (cards waiting on it), each with ' +
      'title, completed, archived, board, and list. A card is blocked while any `blockedBy` card ' +
      'is neither completed nor archived. Works for archived cards too (see ' +
      'kanbini_list_archived). Returns null if the id, or the number on that board, does not ' +
      'exist. When the desktop app is closed, falls back to the last on-disk export.',
    inputSchema: { id: z.string(), boardId: z.string().optional() }
  },
  ({ id, boardId }) =>
    asReadToolResult(async () => {
      const board = boardId === undefined ? undefined : await readBoardId(boardId)
      return readWithFallback(
        'card.get',
        board !== undefined ? { id, boardId: board } : { id },
        (snap) => headlessCardView(snap, id, board)
      )
    })
)

server.registerTool(
  'kanbini_search_cards',
  {
    title: 'Search cards across all boards',
    description:
      'Global card search by case-insensitive substring on title, ' +
      'description, and label name; a query like `#142` or `142` also ' +
      "finds each board's card with that number (numbers are per " +
      'board; check boardName). Returns up to `limit` (default ' +
      '50, max 100) hits, each carrying cardId + number + title + boardId ' +
      '+ boardName + listName + matchedLabels + matchKind ("number" | ' +
      '"title" | "label" | "description") + updatedAt. Sort puts the ' +
      'numbered cards first, then title matches, then label, then ' +
      'description; ties break by recency. Archived cards ' +
      'and closed lists are excluded. Use cardId with kanbini_get_card ' +
      'to fetch full detail for any hit. When the desktop app is ' +
      "closed, falls back to the last on-disk export.",
    inputSchema: {
      query: z.string().min(1),
      limit: z.number().int().positive().max(100).optional()
    }
  },
  ({ query, limit }) =>
    asReadToolResult(() =>
      readWithFallback(
        'search.cards',
        limit !== undefined ? { query, limit } : { query },
        (snap) => headlessSearchCards(snap, query, limit)
      )
    )
)

server.registerTool(
  'kanbini_get_agenda',
  {
    title: "Get the user's agenda across all boards",
    description:
      "What's on the user's plate, across every board in one call. Returns " +
      'four sections: `overdue` (open cards due before today), `today` ' +
      '(open cards due today), `upcoming` (open cards due in the next ' +
      '`upcomingDays`, default 7), and `completed` (cards marked complete ' +
      'today or in the previous `completedDays`, default 7, newest first). ' +
      'Due sections are ordered soonest first, then by priority. Each item ' +
      'carries cardId, title, boardId, boardName, listName, dueAt (epoch ms, ' +
      'local midnight of the due day), priority, completedAt, and `blocked` ' +
      '(still waiting on an open card, so it cannot really start yet). `totals` ' +
      'counts every card per section even when `limit` (default 50 per ' +
      'section, max 100) trims the arrays. "Today" is the local calendar ' +
      "day on the user's machine; `dayStart` is its midnight. Archived " +
      'cards, archived lists, and archived boards are left out. Use this ' +
      'for "what should I work on", "what is overdue", or "what did I get ' +
      'done this week" instead of walking every board. When the desktop ' +
      'app is closed, falls back to the last on-disk export.',
    inputSchema: {
      upcomingDays: z.number().int().min(1).max(AGENDA_MAX_DAYS).optional(),
      completedDays: z.number().int().min(1).max(AGENDA_MAX_DAYS).optional(),
      limit: z.number().int().positive().max(100).optional()
    }
  },
  ({ upcomingDays, completedDays, limit }) => {
    const params = {
      ...(upcomingDays !== undefined ? { upcomingDays } : {}),
      ...(completedDays !== undefined ? { completedDays } : {}),
      ...(limit !== undefined ? { limit } : {})
    }
    return asReadToolResult(() =>
      readWithFallback('agenda.get', params, (snap) =>
        headlessAgenda(snap, params)
      )
    )
  }
)

// ─── write tools ─────────────────────────────────────────────────
// Every write tool is an entry in OPS (ops.ts): its arguments, and how
// they become the app's mutations. One mutation goes through the control
// channel's `mutate`; several (a card made with its labels and checklist,
// or a kanbini_batch) go through `mutate.batch`: one transaction, so
// nothing lands unless everything does, and one undo step. Main validates
// with the same zod schemas the renderer uses and broadcasts `changed`, so
// an open window shows the edit live.

const resolverIO: ResolverIO = {
  listBoards: () => rpc('boards.list', {}) as Promise<BoardsListView>,
  boardView: (boardId) => rpc('board.getView', { boardId }) as Promise<BoardView | null>,
  card: (ref, boardId) =>
    rpc('card.get', boardId !== undefined ? { id: ref, boardId } : { id: ref }) as Promise<CardView | null>
}

/** A board given by id or name, for the read tools (works when the app
 *  is closed too). */
async function readBoardId(ref: string): Promise<string> {
  if (looksLikeId(ref)) return ref.trim()
  const { data } = await readWithFallback('boards.list', {}, (snap) => headlessListBoards(snap))
  return findBoard(data as BoardsListView, ref)
}

/** Run a tool's lookups (names, numbers), but report a closed app as
 *  such rather than as whatever the first lookup tripped over. */
async function unlessOffline<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (!(e instanceof AppOfflineError) && !(await loadDiscovery())) throw new AppOfflineError()
    throw e
  }
}

async function applyMutations(mutations: Mutation[]): Promise<MutationResult[]> {
  if (mutations.length === 1) return [(await rpc('mutate', mutations[0])) as MutationResult]
  return (await rpc('mutate.batch', mutations)) as MutationResult[]
}

for (const spec of OPS) {
  server.registerTool(
    `kanbini_${spec.name}`,
    { title: spec.title, description: spec.description, inputSchema: spec.shape },
    (args: Record<string, unknown>) =>
      asToolResult(async () => {
        const built = await unlessOffline(() => spec.build(args, new Resolver(resolverIO)))
        const results = await applyMutations(built.mutations)
        return results[built.primary]
      })
  )
}

const BATCH_MAX_STEPS = 200

server.registerTool(
  'kanbini_batch',
  {
    title: 'Make many changes at once',
    description:
      'Apply many changes in ONE call, as one change: all of them land or none do, and one ' +
      'Ctrl+Z in the app takes them all back. Use it whenever you would otherwise call write ' +
      'tools several times (filling a board, tidying a list, moving or relabelling many cards). ' +
      '`steps` (up to 200) run in order; each is `{ op, ...arguments }` where `op` is a write ' +
      'tool name without `kanbini_` (create_card, update_card, move_card, set_card_labels, ' +
      'archive_card, create_list, create_label, post_comment, create_checklist, ...) and the ' +
      'arguments are exactly that tool\'s. `boardId` (id or name) is the default board for every ' +
      'step, so steps can name cards by number (`#142`) and lists / labels by name without ' +
      'repeating it; a step may still pass its own. A step that creates something can take `ref: ' +
      '"name"`, and later steps use `"$name"` wherever an id goes, e.g. [{ op: "create_list", ' +
      'name: "Sprint 4", ref: "s4" }, { op: "create_card", listId: "$s4", title: "Plan" }]. ' +
      'Lists and labels a step creates can also be named by their name later on. Attachments ' +
      'are not available here. Returns { changes, steps: [{ step, op, id, ref? }] } with the ' +
      'id of what each step changed or made. A failing step is reported by number and nothing ' +
      'is changed.',
    inputSchema: {
      boardId: z.string().optional(),
      steps: z
        .array(
          z
            .object({
              op: z.enum(OPS.map((o) => o.name) as [string, ...string[]]),
              ref: z.string().optional()
            })
            .passthrough()
        )
        .min(1)
        .max(BATCH_MAX_STEPS)
    }
  },
  ({ boardId, steps }) =>
    asToolResult(async () => {
      const r = new Resolver(resolverIO, boardId)
      const mutations: Mutation[] = []
      const spans: { start: number; primary: number }[] = []
      await unlessOffline(async () => {
        for (const [i, step] of steps.entries()) {
          const spec = OPS_BY_NAME.get(step.op)!
          const where = `Step ${i + 1} (${step.op})`
          const { op: _op, ref, ...args } = step as Record<string, unknown> & { ref?: string }
          if (ref !== undefined && !spec.creates) {
            throw new Error(
              `${where}: \`ref\` names something a step creates, and ${step.op} creates nothing.`
            )
          }
          // The batch's board is every step's default, including ops
          // where `boardId` is required (create_list, create_label).
          if (boardId !== undefined && 'boardId' in spec.shape && args['boardId'] === undefined) {
            args['boardId'] = boardId
          }
          const parsed = z.object(spec.shape).strict().safeParse(args)
          if (!parsed.success) {
            throw new Error(`${where}: ${z.prettifyError(parsed.error)}`)
          }
          let built
          try {
            built = await spec.build(parsed.data, r, ref)
          } catch (e) {
            throw new Error(`${where}: ${e instanceof Error ? e.message : String(e)}`)
          }
          spans.push({ start: mutations.length, primary: built.primary })
          mutations.push(...built.mutations)
        }
      })
      if (mutations.length > MAX_BATCH_MUTATIONS) {
        throw new Error(
          `These steps add up to ${mutations.length} changes; one batch takes up to ` +
            `${MAX_BATCH_MUTATIONS}. Split it into smaller batches.`
        )
      }
      let results: MutationResult[]
      try {
        results = await applyMutations(mutations)
      } catch (e) {
        throw new Error(batchFailure(e, spans, steps), { cause: e })
      }
      return {
        changes: mutations.length,
        steps: steps.map((s, i) => ({
          step: i + 1,
          op: s.op,
          id: results[spans[i]!.start + spans[i]!.primary]!.id,
          ...(s.ref !== undefined ? { ref: s.ref } : {})
        }))
      }
    })
)

/** Name the step behind a batch the app refused ("Change 7 of 12 ..."
 *  from applyMutationsRecorded, or a single mutate's own error). */
function batchFailure(
  e: unknown,
  spans: { start: number }[],
  steps: { op: string }[]
): string {
  const msg = e instanceof Error ? e.message : String(e)
  const m = /Change (\d+) of \d+ \([^)]*\) failed: ([\s\S]*)$/.exec(msg)
  const index = m ? Number(m[1]) - 1 : spans.length === 1 ? 0 : -1
  if (index < 0) return `The batch failed and nothing was changed: ${msg}`
  let step = 0
  while (step + 1 < spans.length && spans[step + 1]!.start <= index) step++
  return `Step ${step + 1} (${steps[step]!.op}) failed, so nothing was changed: ${m ? m[2] : msg}`
}

server.registerTool(
  'kanbini_list_archived',
  {
    title: 'List archived cards and lists',
    description:
      'Return what a board has archived: `lists` (archived lists, with ' +
      'how many live cards are inside) and `cards` (archived cards, most ' +
      'recently touched first, each with its list name). A card whose ' +
      '`listClosed` is true sits in an archived list, so restoring the ' +
      'card alone will not make it visible - restore the list too. Use ' +
      'the ids with kanbini_archive_card / kanbini_archive_list ' +
      '(archived: false) to bring things back. Returns null for an ' +
      'unknown boardId. When the desktop app is closed, falls back to ' +
      'the last on-disk export.',
    inputSchema: { boardId: z.string() }
  },
  ({ boardId }) =>
    asReadToolResult(() =>
      readWithFallback('board.archived', { boardId }, (snap) =>
        headlessArchivedItems(snap, boardId)
      )
    )
)

server.registerTool(
  'kanbini_add_attachment',
  {
    title: 'Attach a file to a card',
    description:
      'Attach a file to a card, from ONE of two sources. (1) `path`: an ' +
      'absolute path to a local file, which the app copies in (up to ' +
      '100 MB) - use this for files that already exist on disk. (2) ' +
      '`filename` + `content`: inline data you produce yourself, as ' +
      '`encoding: "utf8"` text (the default - notes, CSV, code) or ' +
      '`encoding: "base64"` for small binaries (up to 10 MB decoded). ' +
      'The filename\'s extension sets the file type; unsafe characters ' +
      'are replaced. Returns the stored attachment ({ id, filename, ' +
      'mime, size, ... , boardId }). To show an image as the card\'s ' +
      'cover, pass the returned id as `coverAttachmentId` to ' +
      'kanbini_update_card. ' +
      CARD_REF_HINT,
    inputSchema: {
      cardId: z.string(),
      boardId: z
        .string()
        .optional()
        .describe('The board id or name, when the card is given by number (#142)'),
      path: z.string().min(1).optional(),
      filename: z.string().min(1).max(255).optional(),
      content: z.string().optional(),
      encoding: z.enum(['utf8', 'base64']).optional()
    }
  },
  ({ cardId: ref, boardId, path, filename, content, encoding }) =>
    asToolResult(async () => {
      const cardId = await new Resolver(resolverIO).card(ref, boardId)
      const inline = filename !== undefined || content !== undefined
      if (path !== undefined && inline) {
        throw new Error(
          'Pass either `path` OR `filename` + `content`, not both.'
        )
      }
      if (path !== undefined) {
        if (!isAbsolute(path)) {
          throw new Error(
            `\`path\` must be absolute (got "${path}"). The app resolves ` +
              'it in its own process, where a relative path would mean ' +
              'something different.'
          )
        }
        return rpc('attachment.add', { cardId, path })
      }
      if (filename === undefined || content === undefined) {
        throw new Error(
          'Pass `path` for a file on disk, or both `filename` and ' +
            '`content` for inline data.'
        )
      }
      return rpc('attachment.add', {
        cardId,
        filename,
        content,
        encoding: encoding ?? 'utf8'
      })
    })
)

server.registerTool(
  'kanbini_delete_attachment',
  {
    title: 'Delete an attachment',
    description:
      'Delete an attachment from its card, including the stored file. ' +
      'If it was the card\'s cover, the cover is cleared. The user can ' +
      'undo this in the app (Ctrl+Z) but the undo restores only the ' +
      'entry, NOT the file, so confirm intent first. Attachment ids come ' +
      'from kanbini_get_card.',
    inputSchema: { id: z.string() }
  },
  ({ id }) => asToolResult(() => rpc('attachment.delete', { id }))
)

// ─── prompts ─────────────────────────────────────────────────────
// Canned starting points a client can offer the user (Claude Desktop
// lists them in its prompt picker; Claude Code as slash commands). They
// only phrase a request - the tools above do the work, so they need no
// channel method of their own.

server.registerPrompt(
  'plan_my_day',
  {
    title: 'Plan my day',
    description:
      "Review what's overdue, due today, and coming up across all Kanbini " +
      'boards, and suggest an order to work through it.'
  },
  () => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text:
            'Call kanbini_get_agenda and help me plan my day. Start with ' +
            "anything overdue, then what's due today, most urgent first, " +
            'naming the board each card is on. Suggest an order to tackle ' +
            "today's cards, putting blocked ones (`blocked: true`) last and " +
            "saying what they wait on, and point out overdue ones I should reschedule " +
            'or drop. Briefly mention what is coming up in the next few ' +
            "days so nothing surprises me. Don't change anything on my " +
            'boards unless I ask.'
        }
      }
    ]
  })
)

server.registerPrompt(
  'log_work',
  {
    title: 'Log work as a card',
    description:
      'Record work that was just done as a completed Kanbini card, with a ' +
      'short write-up in its description.',
    argsSchema: {
      summary: z
        .string()
        .optional()
        .describe('What was done, if the conversation does not already say'),
      board: z
        .string()
        .optional()
        .describe('Board to log it on (name or id)')
    }
  },
  ({ summary, board }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text:
            'Log the work we just did as a card in Kanbini.\n\n' +
            (summary ? `What was done: ${summary}\n\n` : '') +
            (board
              ? `Use the board "${board}" (match it with kanbini_list_boards).\n\n`
              : 'Pick the board with kanbini_list_boards. If none clearly ' +
                'fits, ask me which one instead of guessing, and never create ' +
                'a board without asking.\n\n') +
            'Put the card in a list named like Done or Complete if the board ' +
            'has one, otherwise in the list the work belongs to. Make it with ' +
            'one kanbini_create_card call: a short title, a Markdown ' +
            'description covering what changed, why, and any follow-ups, and ' +
            'completed: true. If there are follow-ups, offer to add them as ' +
            'their own cards. Tell me which board and list you used.'
        }
      }
    ]
  })
)

const transport = new StdioServerTransport()
await server.connect(transport)
// The client hanging up (stdin EOF) ends the session. Exit explicitly
// rather than relying on the event loop draining: a pooled keep-alive
// socket to the control channel can hold it open, and behind the Claude
// Code plugin's launcher an orphaned server would linger.
process.stdin.on('end', () => process.exit(0))
