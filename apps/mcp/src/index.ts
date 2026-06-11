import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  APP_CODENAME,
  decodeEscapedWhitespace,
  type Mutation,
  type MutationResult
} from '@kanbini/shared'
import {
  headlessBoardView,
  headlessCardView,
  headlessListBoards,
  headlessSearchCards,
  loadHeadlessSnapshot,
  type HeadlessSnapshot
} from './headless.js'

// @kanbini/mcp - stdio MCP server (M3-B + M3-tail). Claude Desktop /
// Claude Code launch this process, hand it the MCP protocol over
// stdio, and call our tools. Each tool POSTs to the desktop app's
// control channel (M3-A) using the bearer token from
// `<userData>/mcp.json`.
//
// Read tools (M3-B + M4-G): kanbini_list_boards, kanbini_get_board,
//   kanbini_get_card.
// Write tools (M3-tail + M4-G): create / update / move / delete cards,
// set labels, post AI-authored comments, manage checklists, create
// boards. Every successful write triggers main's broadcastChange, so
// an open renderer reflects AI edits live.

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
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
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
    let text = JSON.stringify(data, null, 2)
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
      'Return one Kanbini board view (project, lists, cards, labels). ' +
      'If boardId is omitted, returns the first board; call ' +
      'kanbini_list_boards first if the database may have multiple ' +
      'boards. Returns null if the id does not match anything. When ' +
      "the desktop app is closed, falls back to the last on-disk export.",
    inputSchema: { boardId: z.string().optional() }
  },
  ({ boardId }) =>
    asReadToolResult(() =>
      readWithFallback(
        'board.getView',
        boardId !== undefined ? { boardId } : {},
        (snap) => headlessBoardView(snap, boardId)
      )
    )
)

server.registerTool(
  'kanbini_get_card',
  {
    title: 'Get Kanbini card',
    description:
      'Return one Kanbini card by id, including title, description, ' +
      'priority (low/medium/high/urgent or null), checklists, comments, ' +
      'attachments, and recent activity feed. Returns null if the id ' +
      'does not exist. When the desktop app is closed, falls back to ' +
      "the last on-disk export.",
    inputSchema: { id: z.string() }
  },
  ({ id }) =>
    asReadToolResult(() =>
      readWithFallback('card.get', { id }, (snap) =>
        headlessCardView(snap, id)
      )
    )
)

server.registerTool(
  'kanbini_search_cards',
  {
    title: 'Search cards across all boards',
    description:
      'Global card search by case-insensitive substring on title, ' +
      'description, and label name. Returns up to `limit` (default 50, ' +
      'max 100) hits, each carrying cardId + title + boardId + boardName ' +
      '+ listName + matchedLabels + matchKind ("title" | "label" | ' +
      '"description") + updatedAt. Sort prioritises title matches, then ' +
      'label, then description; ties break by recency. Archived cards ' +
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

// ─── write tools (M3-tail) ───────────────────────────────────────
// Each tool builds a mutation payload (zMutation discriminated union)
// and POSTs it through the control channel's `mutate` method. Main
// validates with the same zod schemas the renderer uses, applies via
// applyMutation, and broadcasts `changed` so the renderer reflects
// the edit live. Returns the MutationResult { id, boardId }.

const mutate = (m: Mutation): Promise<MutationResult> =>
  rpc('mutate', m) as Promise<MutationResult>

server.registerTool(
  'kanbini_create_board',
  {
    title: 'Create a board',
    description:
      'Create a new empty board (no lists, no cards). `name` is the ' +
      'required board title; `description` is an optional short blurb ' +
      'shown on the home picker. Returns { id, boardId } - both equal ' +
      "the new board's id. The board is added to Kanbini's default " +
      'project automatically (projects are hidden in the UI). Add ' +
      'columns next with kanbini_create_list, then populate them with ' +
      'kanbini_create_card.',
    inputSchema: {
      name: z.string().min(1),
      description: z.string().optional()
    }
  },
  ({ name, description }) =>
    asToolResult(() => mutate({ type: 'board.create', name, description }))
)

server.registerTool(
  'kanbini_create_list',
  {
    title: 'Create a list (column)',
    description:
      'Create a new list (column) at the right end of a board. Returns ' +
      '{ id, boardId }; use the returned id as the listId for ' +
      'kanbini_create_card. Board ids come from kanbini_list_boards or ' +
      'a fresh kanbini_create_board.',
    inputSchema: {
      boardId: z.string(),
      name: z.string().min(1)
    }
  },
  ({ boardId, name }) =>
    asToolResult(() => mutate({ type: 'list.create', boardId, name }))
)

server.registerTool(
  'kanbini_create_card',
  {
    title: 'Create a card',
    description:
      'Create a new card at the end of a list. Returns { id, boardId }. ' +
      'Use kanbini_get_board first to find a listId. `priority` ' +
      "optionally sets one of 'low' | 'medium' | 'high' | 'urgent' at " +
      'creation (omit for unprioritised); use kanbini_update_card for ' +
      'the description and other fields. Respect a list\'s `wipLimit` ' +
      '(visible in the board view): the limit is advisory and not ' +
      'enforced server-side, so check the list\'s current card count ' +
      'before adding when a limit is set.',
    inputSchema: {
      listId: z.string(),
      title: z.string().min(1),
      priority: z
        .enum(['low', 'medium', 'high', 'urgent'])
        .optional()
    }
  },
  ({ listId, title, priority }) =>
    asToolResult(() =>
      mutate({
        type: 'card.create',
        listId,
        title,
        ...(priority ? { priority } : {})
      })
    )
)

server.registerTool(
  'kanbini_update_card',
  {
    title: 'Update card fields',
    description:
      'Patch one or more card fields. `title` and `description` are ' +
      'strings; `description` accepts Markdown - use real line breaks for ' +
      'paragraphs and lists (a literal backslash-n renders as text, not a ' +
      'break). `dueAt` is epoch ms or ' +
      'null to clear. `completed` toggles the checkbox. `coverAttachmentId` ' +
      'is the attachment id to use as the cover banner, or null to clear. ' +
      "`priority` is one of 'low' | 'medium' | 'high' | 'urgent', or null " +
      'to clear. Omit fields you do not want to change.',
    inputSchema: {
      id: z.string(),
      patch: z.object({
        title: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        dueAt: z.number().int().nullable().optional(),
        completed: z.boolean().optional(),
        coverAttachmentId: z.string().nullable().optional(),
        priority: z
          .enum(['low', 'medium', 'high', 'urgent'])
          .nullable()
          .optional()
      })
    }
  },
  ({ id, patch }) =>
    asToolResult(() =>
      mutate({
        type: 'card.update',
        id,
        // Decode a description that was sent with literal "\n" escapes
        // instead of real line breaks (see decodeEscapedWhitespace).
        patch:
          typeof patch.description === 'string'
            ? { ...patch, description: decodeEscapedWhitespace(patch.description) }
            : patch
      })
    )
)

server.registerTool(
  'kanbini_move_card',
  {
    title: 'Move or reorder a card',
    description:
      'Move a card between lists, or reorder within its current list. ' +
      '`toListId` is the destination list. `beforeId` is the id of the ' +
      'card that should sit immediately ABOVE the moved card; `afterId` ' +
      'is the card immediately BELOW. Pass null/omit either for ' +
      'start/end of list. Server mints a fractional-index position ' +
      'between the two neighbours, so calls never collide. Respect the ' +
      "destination list's `wipLimit` when one is set (advisory, not " +
      'enforced server-side - check its card count first). Note: lists ' +
      'with a non-null sortMode order themselves; a move into one ' +
      'lands wherever the sort puts it, not at the requested slot.',
    inputSchema: {
      id: z.string(),
      toListId: z.string(),
      beforeId: z.string().nullable().optional(),
      afterId: z.string().nullable().optional()
    }
  },
  ({ id, toListId, beforeId, afterId }) =>
    asToolResult(() =>
      mutate({
        type: 'card.move',
        id,
        toListId,
        beforeId: beforeId ?? null,
        afterId: afterId ?? null
      })
    )
)

server.registerTool(
  'kanbini_delete_card',
  {
    title: 'Delete a card',
    description:
      'Permanently delete a card. Its checklists, comments, and ' +
      'attachment rows are removed by the FK cascade. Files attached ' +
      'to the card stay on disk until the GC sweep - they cannot be ' +
      'restored from the UI, so confirm intent before calling.',
    inputSchema: { id: z.string() }
  },
  ({ id }) => asToolResult(() => mutate({ type: 'card.delete', id }))
)

server.registerTool(
  'kanbini_set_card_labels',
  {
    title: 'Replace card labels',
    description:
      'Replace the full set of label ids on a card (idempotent). Pass ' +
      'an empty array to remove all labels. Label ids come from the ' +
      "board view's top-level `labels[]`.",
    inputSchema: {
      id: z.string(),
      labelIds: z.array(z.string())
    }
  },
  ({ id, labelIds }) =>
    asToolResult(() => mutate({ type: 'card.setLabels', id, labelIds }))
)

server.registerTool(
  'kanbini_post_comment',
  {
    title: 'Post a comment as the AI',
    description:
      "Post a comment on a card. Author is automatically set to 'ai' " +
      'so it renders with the AI badge in the UI (and is distinguishable ' +
      'from human-written comments). Body is Markdown - put real line ' +
      'breaks between paragraphs and list items. A literal backslash-n ' +
      'renders as the text "\\n", not a line break.',
    inputSchema: {
      cardId: z.string(),
      body: z.string().min(1)
    }
  },
  ({ cardId, body }) =>
    asToolResult(() =>
      mutate({
        type: 'comment.create',
        cardId,
        // Recover line breaks if the client sent literal "\n" escapes
        // instead of real ones (see decodeEscapedWhitespace).
        body: decodeEscapedWhitespace(body),
        author: 'ai'
      })
    )
)

server.registerTool(
  'kanbini_create_checklist',
  {
    title: 'Add a checklist to a card',
    description:
      'Create a new checklist on a card. Returns { id, boardId }; use ' +
      'the returned id with kanbini_add_checklist_item to populate it.',
    inputSchema: {
      cardId: z.string(),
      name: z.string().min(1)
    }
  },
  ({ cardId, name }) =>
    asToolResult(() => mutate({ type: 'checklist.create', cardId, name }))
)

server.registerTool(
  'kanbini_add_checklist_item',
  {
    title: 'Add a checklist item',
    description:
      'Append an item to an existing checklist. Returns { id, boardId }.',
    inputSchema: {
      checklistId: z.string(),
      text: z.string().min(1)
    }
  },
  ({ checklistId, text }) =>
    asToolResult(() =>
      mutate({ type: 'checklistItem.create', checklistId, text })
    )
)

server.registerTool(
  'kanbini_toggle_checklist_item',
  {
    title: 'Check or uncheck a checklist item',
    description:
      'Set the completed flag on a checklist item. Pass true to mark ' +
      'it done, false to reopen.',
    inputSchema: {
      id: z.string(),
      completed: z.boolean()
    }
  },
  ({ id, completed }) =>
    asToolResult(() =>
      mutate({ type: 'checklistItem.update', id, patch: { completed } })
    )
)

const transport = new StdioServerTransport()
await server.connect(transport)
