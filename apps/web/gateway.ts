// The web edition's front door: accounts, sign-in, registration, workspaces, the
// admin page and the MCP endpoint. Every set of boards (an account's own, or
// a shared workspace) runs in its own app process (./server.ts, started on
// first use) that listens only on a socket in its own folder and may touch
// no other files. A signed-in browser's requests go to the app of the
// workspace its tab has open.
//
//   /login, /login/code          sign in: password, then the 2FA code if the account has 2FA
//   /register, /logout           create an account, sign out
//   /account                     who is signed in, which workspace (JSON, for the header menu)
//   /workspaces                  switch, create, share (invite, change roles, remove), accept/decline,
//                                rename, transfer ownership, delete, leave
//   /admin                       registration on/off, invite code, accounts
//   /mcp/<workspace id>          MCP over HTTP, with the token from Settings > MCP
//   /w/<workspace id>/...        the same app routes, pinned to one workspace (one per tab)
//   everything else              the open workspace's app
import { type ChildProcess, fork } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, promises as fsp, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, join, resolve, sep } from 'node:path'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  accessOf,
  answerInvite,
  canEdit,
  canManage,
  checkCode,
  checkPassword,
  createWorkspace,
  dataRoot,
  deleteWorkspace,
  deviceCookie,
  invitesFor,
  managedBy,
  mcpToken,
  newInviteCode,
  register,
  removeMember,
  removeUser,
  renameWorkspace,
  type Role,
  ROLES,
  roleOf,
  save,
  share,
  type Space,
  spaceFor,
  spacesOf,
  store,
  transferOwnership,
  trustedDevice,
  type User,
  userByMcpToken,
  type Workspace
} from './accounts'
import { crossSite, VIEW_ONLY, VIEWER_CHANNELS, VIEWER_TOOLS } from './access'
import { limitFor } from './limits'
import * as pages from './pages'

const port = Number(process.env['PORT'] ?? 8080)
// The repo (or /app in the image): the app's code, which each app process may read.
const APP_ROOT = resolve(__dirname, '../../../..')

// Sessions are saved to <data>/sessions.json so a restart or an update keeps
// people signed in. They're keyed by a hash of the cookie, so the file alone
// signs nobody in.
const COOKIE = 'kanbini_session'
// "Remember me": 30 days on that device. Without it, the cookie ends with the
// browser, and the server ends the session after 12 hours in any case
// (browsers that restore tabs also restore such cookies).
const REMEMBERED_MS = 30 * 24 * 60 * 60 * 1000
const BROWSER_SESSION_MS = 12 * 60 * 60 * 1000
type Session = { userId: string; expires: number; space: string }
const SESSIONS_FILE = join(dataRoot, 'sessions.json')
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex')
const sessions = new Map<string, Session>(
  (() => {
    try {
      return (JSON.parse(readFileSync(SESSIONS_FILE, 'utf8')) as [string, Session][]).filter(([, s]) => s.expires > Date.now())
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[gateway] sessions.json unreadable; everyone signs in again:', err)
      return []
    }
  })()
)
function saveSessions(): void {
  for (const [key, s] of sessions) if (s.expires < Date.now()) sessions.delete(key)
  mkdirSync(dataRoot, { recursive: true })
  writeFileSync(`${SESSIONS_FILE}.tmp`, JSON.stringify([...sessions]), { mode: 0o600 })
  renameSync(`${SESSIONS_FILE}.tmp`, SESSIONS_FILE)
}
function openSpace(session: Session, spaceId: string): void {
  session.space = spaceId
  saveSessions()
}

function token(req: IncomingMessage, name = COOKIE): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(/;\s*/)) {
    if (part.startsWith(`${name}=`)) return part.slice(name.length + 1)
  }
}

// Between the password and the 2FA code: who passed step 1, for 5 minutes.
const CODE_COOKIE = 'kanbini_2fa'
const pendingCode = new Map<string, { userId: string; expires: number; remember: boolean }>()
function pendingSignIn(req: IncomingMessage): { user: User; remember: boolean } | undefined {
  const t = token(req, CODE_COOKIE)
  const pending = t === undefined ? undefined : pendingCode.get(t)
  if (!pending || pending.expires < Date.now()) return undefined
  const user = store.users.find((u) => u.id === pending.userId)
  return user && { user, remember: pending.remember }
}

/** The signed-in account and the workspace its browser last opened. Membership
 *  is checked on every request: someone removed from a workspace lands back on
 *  their own boards. */
function signedIn(req: IncomingMessage) {
  const t = token(req)
  const key = t === undefined ? undefined : hashToken(t)
  const session = key === undefined ? undefined : sessions.get(key)
  if (!session || session.expires < Date.now()) return undefined
  const user = store.users.find((u) => u.id === session.userId)
  if (!user) return undefined
  const space = spaceFor(user, session.space) ?? spacesOf(user)[0]!
  session.space = space.id
  return { user, space, session }
}

// Secure only over HTTPS (through the proxy): the LAN address is plain HTTP.
// No max age: the browser drops the cookie when it closes.
const cookie = (req: IncomingMessage, value: string, maxAgeSeconds: number | undefined, name = COOKIE) =>
  `${name}=${value}; Path=/; HttpOnly; SameSite=Lax` +
  (maxAgeSeconds === undefined ? '' : `; Max-Age=${maxAgeSeconds}`) +
  (req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '')

// Marks a browser that has signed in to an account, so its sign-in tries
// count apart from a stranger's (trustedDevice in accounts.ts). It signs
// nobody in; a year, renewed at each sign-in.
const DEVICE_COOKIE = 'kanbini_device'
const DEVICE_SECONDS = 365 * 24 * 60 * 60
const deviceOf = (req: IncomingMessage) => token(req, DEVICE_COOKIE)

/** Signs the account in. `remember` keeps it signed in on this device for 30
 *  days; otherwise until the browser closes (12 hours at most). */
function startSession(req: IncomingMessage, res: ServerResponse, user: User, remember: boolean): void {
  const t = randomBytes(32).toString('base64url')
  const lasts = remember ? REMEMBERED_MS : BROWSER_SESSION_MS
  sessions.set(hashToken(t), { userId: user.id, expires: Date.now() + lasts, space: user.id })
  saveSessions()
  const pending = token(req, CODE_COOKIE)
  if (pending !== undefined) pendingCode.delete(pending)
  const known = trustedDevice(user, deviceOf(req))
  res.writeHead(303, {
    location: '/',
    'set-cookie': [
      cookie(req, t, remember ? lasts / 1000 : undefined),
      cookie(req, '', 0, CODE_COOKIE),
      cookie(req, known ? deviceOf(req)! : deviceCookie(user), DEVICE_SECONDS, DEVICE_COOKIE)
    ],
    'cache-control': 'no-store'
  })
  res.end()
}

// Until the first account exists, whoever opens set-up first becomes the
// admin. So set-up only answers direct (LAN) requests; NPM and Cloudflare
// add these headers.
const viaProxy = (req: IncomingMessage) =>
  ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'forwarded'].some((h) => h in req.headers)

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 8192) throw new Error('form too large')
    chunks.push(chunk as Buffer)
  }
  // Decoded once, whole: a character split across two chunks stays intact.
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location })
  res.end()
}

function send(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

// One app process per set of boards (about 100 MB each), started on its
// first request and stopped once nobody has used it for IDLE_MS: no new
// request, none still running (an open tab holds its live-update stream
// open, so it counts) and no MCP session. Stopping runs the app's quit path
// (the export and the daily backup); the next request starts it again.
const IDLE_MS = Math.max(1000, Number(process.env['KANBINI_IDLE_MINUTES'] ?? 30) * 60_000)
type App = { proc: ChildProcess; ready: Promise<string>; exited: Promise<void>; lastUsed: number }
const apps = new Map<string, App>()
// Apps on their way out. A new one for the same folder waits for the old one
// to finish its export, so two never share a database.
const stopping = new Map<string, Promise<void>>()
// Requests being answered right now, by set of boards (live-update streams
// included), so a long upload or an open tab keeps its app running.
const active = new Map<string, number>()

/** Stops the app for this set of boards, if it runs; resolves once it has exited. */
function stopApp(id: string): Promise<void> {
  const app = apps.get(id)
  if (!app) return stopping.get(id) ?? Promise.resolve()
  apps.delete(id)
  const done = app.exited.then(() => void stopping.delete(id))
  stopping.set(id, done)
  if (app.proc.exitCode === null && app.proc.signalCode === null) app.proc.kill('SIGTERM')
  return done
}

/** True while a request (an open tab's stream included) or an MCP session is using these boards. */
function inUse(spaceId: string): boolean {
  if ((active.get(spaceId) ?? 0) > 0) return true
  for (const s of mcpSessions.values()) if (s.spaceId === spaceId) return true
  return false
}

setInterval(() => {
  for (const [id, app] of apps) {
    if (Date.now() - app.lastUsed < IDLE_MS || inUse(id)) continue
    console.log(`[gateway] stopping the idle app for ${id}`)
    void stopApp(id)
  }
}, Math.min(5 * 60_000, IDLE_MS)).unref()

async function appFor(space: Space): Promise<string> {
  const leaving = stopping.get(space.id)
  if (leaving) await leaving
  let app = apps.get(space.id)
  if (!app) {
    const socket = join(space.dir, 'app.sock')
    const tmp = join(space.dir, 'tmp')
    mkdirSync(tmp, { recursive: true }) // Electron makes its userData folder; Node doesn't
    const proc = fork(join(__dirname, 'server.cjs'), [], {
      // Node's permission model: this app reads only its own folder and the
      // app's code, and writes only its own folder. MCP's add-attachment and
      // the Obsidian push take server paths from users; this keeps every
      // account out of every other account's files.
      execArgv: [
        '--permission',
        `--allow-fs-read=${space.dir}`,
        `--allow-fs-read=${APP_ROOT}`,
        `--allow-fs-write=${space.dir}`,
        '--allow-addons', // the SQLite driver, which opens only the database file the app names
        '--disable-warning=SecurityWarning' // the reminder --allow-addons prints on every start
      ],
      env: { ...process.env, KANBINI_USERDATA_OVERRIDE: space.dir, KANBINI_SOCKET: socket, TMPDIR: tmp }
    })
    let exitedNow: () => void
    const exited = new Promise<void>((resolve) => (exitedNow = resolve))
    const ready = new Promise<string>((resolve, reject) => {
      proc.once('message', (m) => (m === 'ready' ? resolve(socket) : reject(new Error(String(m)))))
      proc.once('exit', (code) => {
        if (apps.get(space.id) === started) apps.delete(space.id) // a crash; a stop already took it off
        console.warn(`[gateway] app for ${space.dir} exited (${code})`)
        reject(new Error(`app exited (${code})`))
        exitedNow()
      })
    })
    ready.catch(() => {}) // the waiting request reports it
    const started: App = { proc, ready, exited, lastUsed: Date.now() }
    app = started
    apps.set(space.id, app)
  }
  app.lastUsed = Date.now()
  return app.ready
}

/** Stops the app of a workspace or account that no longer exists. */
function stopOrphans(): void {
  for (const id of apps.keys()) {
    if (!store.users.some((u) => u.id === id) && !store.workspaces.some((w) => w.id === id)) void stopApp(id)
  }
}

// Open live-update streams by account and workspace, to cut off someone who
// is removed from a workspace (or whose account is removed).
const streams = new Map<string, Set<ServerResponse>>()
function cutOff(userId: string, spaceId?: string): void {
  for (const [key, open] of streams) {
    const [user, space] = key.split(' ')
    if (user === userId && (spaceId === undefined || space === spaceId)) for (const res of open) res.destroy()
  }
}

async function proxy(req: IncomingMessage, res: ServerResponse, space: Space): Promise<void> {
  active.set(space.id, (active.get(space.id) ?? 0) + 1)
  res.once('close', () => active.set(space.id, (active.get(space.id) ?? 1) - 1))
  let socketPath: string
  try {
    socketPath = await appFor(space)
  } catch {
    return send(res, 502, 'These boards could not start. Try again; the server log has details.')
  }
  const upstream = request({ socketPath, path: req.url, method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers)
    r.pipe(res)
  })
  upstream.on('error', () => (res.headersSent ? res.destroy() : send(res, 502, 'These boards are unavailable.')))
  // A closed tab ends the stream it held open (the live-update events).
  res.on('close', () => upstream.destroy())
  req.pipe(upstream)
}

// MCP: each client session gets its own copy of the stdio MCP server
// (apps/mcp), pointed at the workspace's folder, bridged to Streamable HTTP.
const MCP_SERVER = join(APP_ROOT, 'apps/mcp/dist/index.js')
// Per account: a client that reconnects without ending its session replaces
// its oldest one instead of piling up server processes.
const MAX_MCP_SESSIONS = 5
const mcpSessions = new Map<string, { userId: string; spaceId: string; http: StreamableHTTPServerTransport; lastSeen: number }>()
// Clients that vanish without ending their session: stop their server after an hour of silence.
setInterval(() => {
  for (const s of mcpSessions.values()) if (Date.now() - s.lastSeen > 60 * 60_000) void s.http.close()
}, 5 * 60_000).unref()

async function mcp(req: IncomingMessage, res: ServerResponse, spaceId: string): Promise<void> {
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
  const user = bearer === undefined ? undefined : userByMcpToken(bearer)
  if (!user) {
    res.writeHead(401, { 'www-authenticate': 'Bearer', 'content-type': 'text/plain' })
    return void res.end('Send the token from Kanbini Settings > MCP as a Bearer token.')
  }
  const space = spaceFor(user, spaceId)
  if (!space) return send(res, 404, 'This account has no such workspace.')
  res.setHeader('x-accel-buffering', 'no') // nginx: don't hold back streamed replies
  const sessionId = req.headers['mcp-session-id']
  if (sessionId !== undefined) {
    const session = mcpSessions.get(String(sessionId))
    if (!session || session.userId !== user.id || session.spaceId !== space.id) return send(res, 404, 'Session not found')
    session.lastSeen = Date.now()
    return session.http.handleRequest(req, res)
  }
  // A new session: this must be an initialize request.
  const mine = [...mcpSessions.values()].filter((s) => s.userId === user.id).sort((a, b) => a.lastSeen - b.lastSeen)
  if (mine.length >= MAX_MCP_SESSIONS) void mine[0]!.http.close()
  await appFor(space) // the MCP server works through the app's control channel
  const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>
  const server = new StdioClientTransport({
    command: process.execPath,
    // The same file limits as the app: its own folder and the code.
    args: ['--permission', `--allow-fs-read=${space.dir}`, `--allow-fs-read=${APP_ROOT}`, `--allow-fs-write=${space.dir}`, MCP_SERVER],
    env: { ...env, KANBINI_USERDATA_OVERRIDE: space.dir }
  })
  const http: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true, // plain JSON replies pass proxies more easily than event streams
    onsessioninitialized: (id) => void mcpSessions.set(id, { userId: user.id, spaceId: space.id, http, lastSeen: Date.now() })
  })
  let ended = false
  const end = () => {
    if (ended) return
    ended = true
    if (http.sessionId) mcpSessions.delete(http.sessionId)
    void server.close()
    void http.close()
  }
  // A viewer's AI may only read; checked per message, so a role change applies at once.
  http.onmessage = (message) => {
    const call = message as { id?: string | number; method?: string; params?: { name?: string } }
    if (call.method === 'tools/call' && !canEdit(space, user.id) && !VIEWER_TOOLS.has(call.params?.name ?? '')) {
      return void http.send({ jsonrpc: '2.0', id: call.id!, result: { content: [{ type: 'text', text: VIEW_ONLY }], isError: true } })
    }
    void server.send(message)
  }
  server.onmessage = (message) => void http.send(message)
  http.onclose = end
  server.onclose = end
  await server.start()
  await http.handleRequest(req, res)
  if (!http.sessionId) end() // it wasn't an initialize request
}

/** Settings > MCP: this server's endpoint and the account's token, instead of
 *  the desktop app's loopback channel (see the text swaps in vite.config.ts). */
function mcpInfo(req: IncomingMessage, user: User, space: Space) {
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'
  const url = `${proto}://${req.headers.host}/mcp/${space.id}`
  const bearer = mcpToken(user)
  return {
    channel: { running: true, port: null, token: bearer },
    paths: { mcpJson: url, mcpToken: 'Authorization: Bearer <the token above>', bundle: space.name },
    snippets: {
      mcpClientJson: JSON.stringify(
        { mcpServers: { kanbini: { type: 'http', url, headers: { Authorization: `Bearer ${bearer}` } } } },
        null,
        2
      )
    },
    needsNode: false
  }
}

/** The share form's choices: a role or 'none' per workspace this account manages. */
type Choices = { username: string; access: Map<string, string> }

/** A deleted workspace: everyone loses it at once, its app stops (writing its
 *  export and backup), then its folder moves to <data>/deleted, from which an
 *  admin can bring it back. */
async function putAway(workspace: Workspace): Promise<void> {
  for (const id of workspace.members) cutOff(id, workspace.id)
  for (const session of mcpSessions.values()) if (session.spaceId === workspace.id) void session.http.close()
  await stopApp(workspace.id)
  const dir = join(dataRoot, 'workspaces', workspace.id)
  const kept = join(dataRoot, 'deleted', `${workspace.id}-${Date.now()}`)
  await fsp.mkdir(dirname(kept), { recursive: true })
  await fsp.rename(dir, kept).catch((err) => {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err // never opened: no folder to keep
  })
  console.log(`[gateway] workspace ${workspace.id} deleted; its folder is in ${kept}`)
}

async function workspaces(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: NonNullable<ReturnType<typeof signedIn>>,
  query: URLSearchParams
): Promise<void> {
  const { user, session } = ctx
  const nameOf = (id: string) => store.users.find((u) => u.id === id)?.username ?? 'someone'
  const show = (status: number, error?: string, choices?: Choices, selectedId?: string) => {
    const open = spaceFor(user, session.space) ?? spacesOf(user)[0]!
    // Details: the workspace picked with "Details", else the one open now.
    const selected = spaceFor(user, selectedId ?? query.get('workspace') ?? undefined) ?? open
    const managed = managedBy(user)
    // Everyone with access to, or an invitation to, a workspace this account manages.
    const people = store.users
      .filter((u) => u.id !== user.id)
      .map((u) => ({
        name: u.username,
        access: managed.flatMap((workspace) => {
          const access = accessOf(workspace, u.id)
          return access ? [{ workspace, ...access }] : []
        })
      }))
      .filter((p) => p.access.length > 0)
    // Change: fill the form with that person's current access.
    // Only someone already in (or invited to) one of these workspaces, so the
    // link can't be used to test which user names exist.
    const person = query.get('person')?.toLowerCase()
    const target = person
      ? store.users.find((u) => u.username === person && managed.some((w) => accessOf(w, u.id)))
      : undefined
    const editing: Choices | undefined =
      choices ??
      (target && {
        username: target.username,
        access: new Map(managed.map((w) => [w.id, accessOf(w, target.id)?.role ?? 'none']))
      })
    const members = selected.workspace
      ? [
          ...selected.workspace.members.map((id) => ({ id, name: nameOf(id), role: roleOf(selected.workspace!, id)!, invited: false })),
          ...(selected.workspace.invites ?? []).map((i) => ({ id: i.userId, name: nameOf(i.userId), role: i.role ?? 'editor', invited: true }))
        ]
      : []
    const incoming = invitesFor(user).map(({ workspace, invite: i }) => ({ workspace, by: nameOf(i.by), role: i.role ?? 'editor' }))
    pages.workspaces(res, status, { user, open, selected, spaces: spacesOf(user), members, incoming, managed, people, editing, error })
  }
  if (req.method !== 'POST') return show(200)
  const form = await readForm(req)
  // The workspace a details action names, if this account is in it.
  const id = form.get('id') ?? undefined
  const named = spaceFor(user, id)?.workspace
  const ownerOnly = (what: string) => show(403, `Only the owner can ${what}.`, undefined, id)
  switch (form.get('action')) {
    case 'switch': {
      const target = spaceFor(user, id)
      if (!target) return show(403, "You're not in that workspace.")
      openSpace(session, target.id)
      return redirect(res, '/')
    }
    case 'create': {
      const created = createWorkspace(user, form.get('name') ?? '')
      if (typeof created === 'string') return show(400, created)
      openSpace(session, created.id)
      console.log(`[gateway] ${user.username} created workspace ${created.id}`)
      return redirect(res, '/')
    }
    case 'share': {
      const access = new Map<string, Role | 'none'>()
      for (const w of managedBy(user)) {
        const choice = form.get(`role:${w.id}`)
        if (choice === 'none' || ROLES.some((r) => r.role === choice)) access.set(w.id, choice as Role | 'none')
      }
      const username = form.get('username') ?? ''
      const result = share(user, username, access)
      if (typeof result === 'string') return show(400, result, { username, access })
      for (const w of result.removedFrom) cutOff(result.target.id, w.id)
      stopOrphans()
      return redirect(res, '/workspaces#people')
    }
    case 'accept':
    case 'decline': {
      const answered = answerInvite(user, id ?? null, form.get('action') === 'accept')
      if (!answered) return show(404, 'That invitation is no longer open.')
      if (form.get('action') === 'decline') return redirect(res, '/workspaces')
      openSpace(session, answered.id)
      return redirect(res, '/')
    }
    case 'rename': {
      if (!named || !canManage(named, user.id)) return show(403, 'Only the owner or a manager can rename a workspace.', undefined, id)
      const error = renameWorkspace(named, form.get('name') ?? '')
      return error ? show(400, error, undefined, id) : redirect(res, `/workspaces?workspace=${named.id}#details`)
    }
    case 'transfer': {
      if (!named || roleOf(named, user.id) !== 'owner') return ownerOnly('hand over a workspace')
      if (!transferOwnership(named, form.get('to'))) return show(400, 'Pick a member of the workspace.', undefined, id)
      console.log(`[gateway] ${user.username} made ${nameOf(named.owner)} owner of workspace ${named.id}`)
      return redirect(res, `/workspaces?workspace=${named.id}#details`)
    }
    case 'delete': {
      if (!named || roleOf(named, user.id) !== 'owner') return ownerOnly('delete a workspace')
      deleteWorkspace(named)
      void putAway(named).catch((err) => console.error(`[gateway] couldn't put away workspace ${named.id}:`, err))
      return redirect(res, '/workspaces')
    }
    case 'leave': {
      if (!named) return show(400, "You're not in that workspace.")
      if (roleOf(named, user.id) === 'owner') return show(400, 'Make someone else the owner first, or delete the workspace.', undefined, id)
      removeMember(named, user.id)
      cutOff(user.id, named.id)
      stopOrphans()
      if (session.space === named.id) openSpace(session, user.id)
      return redirect(res, '/workspaces')
    }
  }
  return show(400, 'Unknown action.')
}

function removeAccount(id: string | null): void {
  const user = store.users.find((u) => u.id === id && !u.admin)
  if (!user) return
  removeUser(user)
  for (const [key, s] of sessions) if (s.userId === user.id) sessions.delete(key)
  saveSessions()
  cutOff(user.id)
  stopOrphans()
  console.log(`[gateway] removed account ${user.username}`)
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x')
  let path = url.pathname
  const ctx = signedIn(req)
  const first = store.users.length === 0

  if (path.startsWith('/mcp/')) return mcp(req, res, path.slice('/mcp/'.length))
  // Everything below is cookie-authenticated (MCP above uses a bearer token),
  // so a change sent from another site's page is refused (see access.ts).
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET') && crossSite(req.headers)) {
    return send(res, 403, 'That request came from another site, so it was refused.')
  }
  // The sign-in pages use the app's stylesheet (open-source CSS, no user data).
  if (pages.appCss && path === pages.appCss.href) {
    res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable' })
    return void res.end(pages.appCss.body)
  }
  if (path === '/login') {
    if (first) return redirect(res, '/register')
    if (req.method !== 'POST') return ctx ? redirect(res, '/') : pages.login(res, 200, { open: store.registration })
    const form = await readForm(req)
    const result = await checkPassword(form, deviceOf(req))
    const remember = form.get('remember') === '1'
    if (typeof result === 'string') {
      console.warn(`[gateway] failed sign-in from ${req.headers['x-forwarded-for'] ?? req.socket.remoteAddress}`)
      return pages.login(res, 401, { open: store.registration, error: result, username: form.get('username') ?? '', remember })
    }
    if (!result.totpSecret) return startSession(req, res, result, remember)
    for (const [k, p] of pendingCode) if (p.expires < Date.now()) pendingCode.delete(k) // abandoned code steps
    const t = randomBytes(32).toString('base64url')
    pendingCode.set(t, { userId: result.id, expires: Date.now() + 5 * 60_000, remember })
    res.writeHead(303, { location: '/login/code', 'set-cookie': cookie(req, t, 5 * 60, CODE_COOKIE) })
    return void res.end()
  }
  if (path === '/login/code') {
    const pending = pendingSignIn(req)
    if (!pending) return redirect(res, '/login')
    if (req.method !== 'POST') return pages.loginCode(res, 200)
    const error = checkCode(pending.user, (await readForm(req)).get('code'), deviceOf(req))
    if (error) {
      console.warn(`[gateway] failed 2FA code from ${req.headers['x-forwarded-for'] ?? req.socket.remoteAddress}`)
      return pages.loginCode(res, 401, error)
    }
    return startSession(req, res, pending.user, pending.remember)
  }
  if (path === '/register') {
    if (first && viaProxy(req)) return pages.setupBlocked(res)
    if (!first && !store.registration) return pages.closed(res)
    if (req.method !== 'POST') return pages.register(res, 200, { first })
    const form = await readForm(req)
    const result = await register(form)
    if (typeof result === 'string') return pages.register(res, 400, { first, error: result, form })
    console.log(`[gateway] account created: ${result.username}${result.admin ? ' (admin)' : ''}`)
    return startSession(req, res, result, true) // stays signed in where it was created, as before
  }
  if (path === '/logout' && req.method === 'POST') {
    const t = token(req)
    if (t !== undefined) sessions.delete(hashToken(t))
    saveSessions()
    res.writeHead(204, { 'set-cookie': cookie(req, '', 0) })
    return void res.end()
  }

  if (!ctx) {
    if (req.method === 'GET' && path === '/') return redirect(res, first ? '/register' : '/login')
    return send(res, 401, 'Sign in first')
  }
  const { user } = ctx
  let space = ctx.space
  // A tab pins the workspace it loaded with: bridge.ts prefixes its calls with
  // /w/<id>, so switching workspace in one tab never redirects another tab's edits.
  const pinned = /^\/w\/([0-9a-f]{16})(\/.*)$/.exec(path)
  if (pinned) {
    const tabSpace = spaceFor(user, pinned[1])
    if (!tabSpace) return send(res, 410, "You're no longer in that workspace.")
    space = tabSpace
    path = pinned[2]!
    req.url = path + url.search
  }
  if (path === '/account') {
    const account = {
      username: user.username,
      admin: user.admin,
      workspace: { id: space.id, name: space.name, role: space.workspace ? roleOf(space.workspace, user.id) : 'owner' },
      invites: invitesFor(user).length
    }
    return send(res, 200, JSON.stringify(account), 'application/json')
  }
  if (path === '/workspaces') return workspaces(req, res, ctx, url.searchParams)
  // The IPC channel an /api/ call names, decoded the way the app decodes it.
  const channel = path.startsWith('/api/') ? decodeURIComponent(path.slice('/api/'.length)) : undefined
  if (channel === 'mcp:info') return send(res, 200, JSON.stringify(mcpInfo(req, user, space)), 'application/json')
  // Link previews make the server fetch pages from the internet, so the
  // admin decides; the in-app setting alone lives in each person's browser.
  if (channel === 'linkPreview:create' && !store.linkPreviews) {
    return send(res, 403, 'Link previews are turned off on this server. The admin can turn them on.')
  }
  if (path === '/admin') {
    if (!user.admin) return send(res, 403, 'Only the admin can open this page.')
    if (req.method === 'POST') {
      const form = await readForm(req)
      const action = form.get('action')
      if (action === 'open' || action === 'close') store.registration = action === 'open'
      if (action === 'previews-on' || action === 'previews-off') store.linkPreviews = action === 'previews-on'
      if (action === 'invite') store.inviteCode = newInviteCode()
      if (action === 'remove') removeAccount(form.get('id'))
      save()
      return redirect(res, '/admin')
    }
    return pages.admin(res, store)
  }
  if (path.startsWith('/kanbini-file/')) {
    // Image and file links carry no workspace, but every file path holds a
    // fresh id: serve it from whichever of this account's workspaces has it.
    const rel = decodeURIComponent(path.slice('/kanbini-file/'.length))
    space =
      spacesOf(user).find((s) => {
        const abs = resolve(s.dir, rel)
        return abs.startsWith(s.dir + sep) && existsSync(abs)
      }) ?? space
  }
  // Viewers read; the server refuses their changes (the UI alone wouldn't stop a script).
  if (req.method === 'POST' && channel !== undefined && !canEdit(space, user.id) && !VIEWER_CHANNELS.has(channel)) {
    return send(res, 403, VIEW_ONLY)
  }
  if (path.startsWith('/api/') && Number(req.headers['content-length'] ?? 0) > limitFor(req.headers)) {
    // Refused here, before any of it reaches the app (see limits.ts).
    res.setHeader('connection', 'close')
    return send(res, 413, `That's over the ${limitFor(req.headers) / 1024 / 1024} MB limit.`)
  }
  if (path === '/api/events') {
    const key = `${user.id} ${space.id}`
    const open = streams.get(key) ?? new Set()
    streams.set(key, open.add(res))
    res.on('close', () => open.delete(res))
  }
  // The page reads this once, at load, to pin its tab to this workspace.
  if (req.method === 'GET' && path === '/') res.setHeader('set-cookie', `kanbini_space=${space.id}; Path=/; SameSite=Lax`)
  return proxy(req, res, space)
}

const server = createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error('[gateway]', req.method, req.url, err)
    if (!res.headersSent) send(res, 500, 'Server error')
    else res.destroy()
  })
}).listen(port, () => console.log(`[gateway] Kanbini web edition on http://0.0.0.0:${port}`))

// Each app writes its export and daily backup on SIGTERM; wait for them.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server.close()
    void Promise.all([...[...apps.keys()].map(stopApp), ...stopping.values()]).then(() => process.exit(0))
  })
}
