import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  type Db,
  applyMutationRecorded,
  getBoardView,
  getCardView,
  listBoards,
  searchCards
} from '@kanbini/db'
import {
  zBoardsListView,
  zBoardView,
  zCardView,
  zGetBoardViewRequest,
  zGetCardViewRequest,
  zMutation,
  zMutationResult,
  zSearchCardsRequest,
  zSearchHits
} from '@kanbini/shared'

// MCP control channel (M3-A read, M3-tail writes). A minimal HTTP/JSON
// RPC bound to 127.0.0.1 that the @kanbini/mcp stdio server uses to
// read and mutate board state from the running app. Same-process
// dispatch - no IPC, no extra DB connection - so AI edits are live
// and the renderer's `changed` subscription picks them up immediately.
//
// Security model:
// - Bound to 127.0.0.1 only (no LAN exposure).
// - Bearer token from `userData/mcp-token` (32 random bytes hex,
//   persisted across restarts, 0o600 on POSIX). MCP server reads it
//   too; mismatched tokens get a 401 with constant-time compare.
// - { port, token, pid } also written to `userData/mcp.json` so the
//   MCP server can discover the running app's port (ephemeral port,
//   server.listen(0)).
// - Method allow-list - adding a method is a one-liner. The single
//   `mutate` method accepts the full zMutation discriminated union,
//   same shape as the renderer's IPC.mutate channel.
//
// Known limitation: `attachment.delete` issued via MCP removes the DB
// row but does NOT unlink the file on disk (the renderer IPC handler
// does that synchronously around applyMutation). Orphan attachment
// directories are caught by the M5 GC sweep already in the backlog -
// acceptable since the AI tool surface (apps/mcp) doesn't expose
// attachment.delete yet.

const HOST = '127.0.0.1'
const TOKEN_FILE = 'mcp-token'
const INFO_FILE = 'mcp.json'
const MAX_BODY_BYTES = 1 * 1024 * 1024 // 1 MB

/** Side-effects a method may want to fire after touching the DB. */
interface MethodContext {
  /** Called after a successful write so renderers refetch and AI edits
   *  show up live. Pass null for board-agnostic writes. */
  onChange: (boardId: string | null) => void
}

type Method = (db: Db, params: unknown, ctx: MethodContext) => unknown

const methods: Record<string, Method> = {
  'boards.list': (db) => {
    return zBoardsListView.parse(listBoards(db))
  },
  'board.getView': (db, raw) => {
    const { boardId } = zGetBoardViewRequest.parse(raw ?? {})
    return zBoardView.nullable().parse(getBoardView(db, boardId))
  },
  'card.get': (db, raw) => {
    const { id } = zGetCardViewRequest.parse(raw ?? {})
    return zCardView.nullable().parse(getCardView(db, id))
  },
  'search.cards': (db, raw) => {
    const { query, limit } = zSearchCardsRequest.parse(raw ?? {})
    return zSearchHits.parse(searchCards(db, query, limit))
  },
  mutate: (db, raw, ctx) => {
    // Accepts the same discriminated union the renderer uses. Each
    // arm's zod schema runs first; applyMutation throws on FK
    // violations etc., which the dispatcher already maps to 400/500.
    // ADR-0036: route through the undo recorder so AI/MCP edits land
    // on the same global undo stack as renderer-issued ones - the
    // user can Ctrl+Z an AI-driven mutation. `restore` is excluded by
    // the zMutation schema's effect of being a writable arm only -
    // the renderer + MCP can technically construct one, but the undo
    // flow goes through `undoOne`/`redoOne` directly and bypasses
    // this method anyway.
    const mutation = zMutation.parse(raw)
    if (mutation.type === 'restore') {
      // Belt + braces - refuse `restore` on the control channel even
      // though no MCP tool exposes it today.
      throw new Error('restore mutation not allowed via control channel')
    }
    const result = zMutationResult.parse(applyMutationRecorded(db, mutation))
    ctx.onChange(result.boardId)
    return result
  }
}

async function loadOrCreateToken(userDataDir: string): Promise<string> {
  const tokenPath = join(userDataDir, TOKEN_FILE)
  try {
    const existing = (await fsp.readFile(tokenPath, 'utf8')).trim()
    // 32 bytes hex = 64 chars; accept anything ≥ that length to leave
    // room for forward-compat (e.g. a longer token in the future).
    if (existing.length >= 64) return existing
  } catch {
    /* not present - fall through to mint a fresh one */
  }
  const token = randomBytes(32).toString('hex')
  await fsp.writeFile(tokenPath, token, { mode: 0o600 })
  return token
}

function isZodError(e: unknown): e is Error & { issues: unknown[] } {
  return (
    e !== null &&
    typeof e === 'object' &&
    (e as { name?: unknown }).name === 'ZodError' &&
    Array.isArray((e as { issues?: unknown }).issues)
  )
}

function checkToken(req: IncomingMessage, expected: string): boolean {
  const auth = req.headers.authorization ?? ''
  if (!auth.startsWith('Bearer ')) return false
  const got = Buffer.from(auth.slice('Bearer '.length))
  const exp = Buffer.from(expected)
  // timingSafeEqual requires equal lengths; bail early on mismatch
  // before the constant-time compare so we don't throw.
  if (got.length !== exp.length) return false
  return timingSafeEqual(got, exp)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let total = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.length === 0) {
        resolve(null)
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, body: unknown): void {
  // `body` may legitimately be `null` (e.g. getBoardView on an empty
  // DB). JSON.stringify(null) → "null", which is what we want.
  const text = JSON.stringify(body ?? null)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text)
  })
  res.end(text)
}

export interface ControlChannelHandle {
  port: number
  token: string
  /** Close the listener and remove the discovery file. Safe to call
   *  multiple times. */
  shutdown(): Promise<void>
}

export interface StartControlChannelOptions {
  db: Db
  userDataDir: string
  /** Fired after every successful write so renderers refetch and AI
   *  edits are visible live. In main this is `broadcastChange`. */
  onChange: (boardId: string | null) => void
}

/** Start the control channel, register the allow-list, and publish
 *  discovery info to `<userData>/mcp.json`. The handle's `shutdown`
 *  should be called from `app.on('before-quit')`. */
export async function startControlChannel(
  opts: StartControlChannelOptions
): Promise<ControlChannelHandle> {
  const { db, userDataDir, onChange } = opts
  const token = await loadOrCreateToken(userDataDir)

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      send(res, 500, { error: (e as Error).message ?? 'internal error' })
    })
  })

  // Keep idle keep-alive sockets open well past the MCP client's own
  // idle timeout. Node's global fetch (undici) pools connections and
  // recycles an idle one after ~4 s; Node's HTTP server default
  // keepAliveTimeout is 5 s. With the server's window the SHORTER of the
  // two, the server could close a socket a beat before the client reuses
  // it, and the client's next request lands on a dead socket
  // (ECONNRESET) - which the MCP server used to misread as "app
  // offline", surfacing a spurious tool error right after a real call.
  // Making the server outlive the client closes the race: the client
  // recycles its socket first and reconnects cleanly. headersTimeout
  // stays above keepAliveTimeout (Node requires the ordering).
  server.keepAliveTimeout = 60_000
  server.headersTimeout = 65_000

  async function handle(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    if (req.method !== 'POST' || req.url !== '/rpc') {
      send(res, 404, { error: 'not found' })
      return
    }
    if (!checkToken(req, token)) {
      send(res, 401, { error: 'unauthorized' })
      return
    }
    let body: { method?: unknown; params?: unknown } | null
    try {
      body = (await readJson(req)) as typeof body
    } catch (e) {
      send(res, 400, { error: (e as Error).message })
      return
    }
    const method = String(body?.method ?? '')
    const handler = methods[method]
    if (!handler) {
      send(res, 400, { error: `unknown method: ${method}` })
      return
    }
    try {
      const result = handler(db, body?.params, { onChange })
      send(res, 200, result)
    } catch (e) {
      // Duck-type ZodError (no `zod` dep at this workspace; instanceof
      // would need it). The shape - name + issues array - is stable
      // across zod versions.
      if (isZodError(e)) {
        send(res, 400, { error: `validation: ${e.message}` })
      } else {
        const msg = e instanceof Error ? e.message : 'internal error'
        send(res, 500, { error: msg })
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, HOST, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const addr = server.address()
  if (typeof addr !== 'object' || addr === null) {
    throw new Error('control channel: no address after listen')
  }
  const port = addr.port

  await fsp.writeFile(
    join(userDataDir, INFO_FILE),
    JSON.stringify({ port, token, pid: process.pid }, null, 2),
    { mode: 0o600 }
  )

  let shutdownPromise: Promise<void> | null = null
  return {
    port,
    token,
    shutdown() {
      if (!shutdownPromise) {
        shutdownPromise = (async () => {
          await new Promise<void>((resolve) => server.close(() => resolve()))
          try {
            await fsp.unlink(join(userDataDir, INFO_FILE))
          } catch {
            /* may already be gone */
          }
        })()
      }
      return shutdownPromise
    }
  }
}
