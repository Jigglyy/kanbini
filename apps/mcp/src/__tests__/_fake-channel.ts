import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_CODENAME, type Mutation } from '@kanbini/shared'
import {
  addAttachmentFromRequest,
  applyMutationRecorded,
  deleteAttachmentWithFile,
  getArchivedItems,
  getBoardView,
  getCardView,
  listBoards,
  openDatabase,
  searchCards,
  seedSampleData,
  type Db
} from '@kanbini/db'

// In-process stand-in for `apps/desktop/src/main/control-channel.ts`.
// Spins up:
//   - an in-memory SQLite via the real `openDatabase` (same migrations)
//   - an HTTP server on a random port that mirrors the real
//     control-channel allow-list (board.getView, card.get, boards.list,
//     search.cards, board.archived, attachment.add, attachment.delete,
//     mutate). The attachment methods call the SAME @kanbini/db writers
//     the desktop channel does, against this fake's temp userData, so
//     the files they write are real and assertable.
//   - a temp userData dir with `mcp.json` + `mcp-token` so the spawned
//     MCP server finds them via `KANBINI_USERDATA_OVERRIDE`
//
// Why we don't import the desktop control channel directly:
//   apps/desktop owns Electron-specific imports (`app`, `BrowserWindow`,
//   …) that aren't loadable outside an Electron context. Replicating
//   the small HTTP surface is ~50 lines and keeps the test free of an
//   Electron dependency.
//
// Methods are the same string keys main's allow-list uses; the MCP
// server's `rpc()` POSTs to /rpc with `{method, params}`, exactly
// matching what main accepts. If the real channel grows a new method,
// add it here and the MCP suite catches integration regressions.

const here = dirname(fileURLToPath(import.meta.url))
// __tests__/_fake-channel.ts → packages/db/drizzle
const MIGRATIONS = resolve(here, '../../../../packages/db/drizzle')

export interface FakeChannel {
  /** Drizzle handle for the in-memory DB; useful when a test wants
   *  to seed extra data without going through MCP. */
  db: Db
  port: number
  token: string
  /** Absolute path to the temp `<APP_CODENAME>` dir. Pass via
   *  `KANBINI_USERDATA_OVERRIDE` when spawning the MCP server. */
  userDataDir: string
  /** Make the server drop (destroy the socket, no response) the next
   *  `n` incoming requests - simulates the stale keep-alive ECONNRESET
   *  the MCP client must recover from, so a test can exercise its
   *  retry. */
  failNextRequests: (n: number) => void
  /** Stops the HTTP server, closes the DB, removes the temp tree. */
  close: () => Promise<void>
}

export async function startFakeChannel(opts?: {
  /** Seed the sample board + lists + cards so read tests have data
   *  to read. Defaults to true; off for tests that want to start
   *  from an empty DB. */
  seed?: boolean
}): Promise<FakeChannel> {
  const { db, close: closeDb } = openDatabase({
    filePath: ':memory:',
    migrationsFolder: MIGRATIONS
  })
  if (opts?.seed !== false) seedSampleData(db)

  const token = `test-${Math.random().toString(36).slice(2)}`

  // Temp userData up front: attachment methods write under it, so it
  // has to exist before the first request lands. APP_CODENAME segment
  // matches Electron's per-app userData layout the real desktop uses.
  const tmp = await mkdtemp(join(tmpdir(), 'kanbini-mcp-test-'))
  const userDataDir = join(tmp, APP_CODENAME)
  await mkdir(userDataDir, { recursive: true })

  // Test hook: when > 0, destroy the next incoming request's socket
  // without responding (then decrement), so the MCP client's fetch sees
  // a connection reset - mimicking a stale keep-alive socket.
  let failNext = 0

  const server: Server = createServer((req, res) => {
    if (failNext > 0) {
      failNext--
      req.destroy()
      return
    }
    if (req.method !== 'POST' || req.url !== '/rpc') {
      res.statusCode = 404
      res.end()
      return
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.statusCode = 401
      res.end()
      return
    }
    let body = ''
    req.on('data', (chunk: Buffer | string) => {
      body += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    })
    req.on('end', () => {
      let payload: { method?: string; params?: unknown }
      try {
        payload = JSON.parse(body) as typeof payload
      } catch {
        res.statusCode = 400
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: 'invalid JSON' }))
        return
      }
      const method = payload.method
      const params = payload.params
      void (async () => {
        try {
          let result: unknown
          switch (method) {
            case 'board.getView':
              result = getBoardView(
                db,
                (params as { boardId?: string } | undefined)?.boardId
              )
              break
            case 'card.get':
              result = getCardView(db, (params as { id: string }).id)
              break
            case 'boards.list':
              result = listBoards(db)
              break
            case 'search.cards': {
              const p = params as { query: string; limit?: number }
              result = searchCards(db, p.query, p.limit)
              break
            }
            case 'board.archived':
              result = getArchivedItems(
                db,
                (params as { boardId: string }).boardId
              )
              break
            case 'attachment.add': {
              const p = params as Parameters<
                typeof addAttachmentFromRequest
              >[1]['request'] & { encoding?: 'utf8' | 'base64' }
              // The real channel's zod schema defaults `encoding` to utf8;
              // mirror that here rather than pull the schema in.
              const request =
                'path' in p ? p : { ...p, encoding: p.encoding ?? 'utf8' }
              const { attachment, boardId } = await addAttachmentFromRequest(
                db,
                { userDataDir, request }
              )
              result = { ...attachment, boardId }
              break
            }
            case 'attachment.delete':
              result = await deleteAttachmentWithFile(db, {
                userDataDir,
                id: (params as { id: string }).id
              })
              break
            case 'mutate': {
              // Match the real channel's reject-restore-on-control-channel
              // belt-and-braces (the renderer / MCP don't expose it, but
              // a future test client COULD construct one - keep the
              // fake's behaviour identical so a regression here would
              // surface in our suite).
              const m = params as Mutation
              if ((m as { type?: string }).type === 'restore') {
                throw new Error('restore mutation not allowed via control channel')
              }
              // Same file-aware routing as the real channel.
              result =
                m.type === 'attachment.delete'
                  ? await deleteAttachmentWithFile(db, { userDataDir, id: m.id })
                  : applyMutationRecorded(db, m)
              break
            }
            default:
              res.statusCode = 400
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify({ error: `unknown method: ${method}` }))
              return
          }
          // Match the real channel: write the result body directly (NOT
          // wrapped in `{result}`). MCP's `rpc()` returns `res.json()`
          // raw + each tool callback feeds it to JSON.stringify for the
          // text content. A wrapping object would leak into the tool's
          // visible output and break every test's `unwrap().*`.
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(result ?? null))
        } catch (err) {
          res.statusCode = 500
          res.setHeader('content-type', 'application/json')
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err)
            })
          )
        }
      })()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address()
  if (!addr || typeof addr !== 'object') {
    throw new Error('fake channel: failed to bind a port')
  }
  const port = addr.port

  // Plant the discovery files.
  await writeFile(
    join(userDataDir, 'mcp.json'),
    JSON.stringify({ port, token, pid: process.pid })
  )
  await writeFile(join(userDataDir, 'mcp-token'), token)

  return {
    db,
    port,
    token,
    userDataDir,
    failNextRequests: (n: number) => {
      failNext = n
    },
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()))
      closeDb()
      await rm(tmp, { recursive: true, force: true })
    }
  }
}
