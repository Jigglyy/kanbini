// One account's Kanbini: runs the desktop main process unchanged (with
// `electron` swapped for ./electron-shim) on that account's data folder and
// exposes its IPC handlers over HTTP for ./bridge.ts. ./gateway.ts starts it,
// signs people in and forwards their requests; this has no sign-in of its
// own, so it only listens on a socket inside the container.
//
//   POST /api/<ipc channel>   JSON body = the IPC argument; or a raw file
//                             body + x-kanbini-filename / x-kanbini-arg
//                             headers where desktop opens a file dialog
//   GET  /api/events          server-sent events (main's window sends)
//   GET  /kanbini-file/<rel>  attachments + board backgrounds
//   GET  /download/<name>     a board export to save
//   GET  /*                   the renderer build
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, promises as fsp, readFileSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { app, handlers, protocols, request, windowListeners } from './electron-shim'
import { limitFor } from './limits'
import '../desktop/src/main/index'

const socket = process.env['KANBINI_SOCKET']
if (!socket) {
  console.error('[web] The gateway starts this per account; it has no sign-in of its own.')
  process.exit(1)
}
const webRoot = resolve(__dirname, '../web')

// index.html's inline first-paint theme script, allowed by hash (Electron's
// header CSP never reached its file:// page, so it ran there).
const inlineScripts = [...readFileSync(join(webRoot, 'index.html'), 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((m) => `'sha256-${createHash('sha256').update(m[1]!).digest('base64')}'`)
// The desktop app's production CSP, minus its custom scheme.
const CSP = `default-src 'self'; script-src 'self' ${inlineScripts.join(' ')}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'`
// Served files must never run as pages on this origin (an SVG opened in its own tab).
const FILE_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox"

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm'
}

const events = new Set<ServerResponse>()
windowListeners.add((channel, payload) => {
  for (const res of events) res.write(`event: ${channel}\ndata: ${JSON.stringify(payload)}\n\n`)
})
// Cloudflare drops a response idle for 100 s.
setInterval(() => events.forEach((res) => res.write(': ping\n\n')), 25_000).unref()

function send(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': type })
  res.end(body)
}

async function serveFile(res: ServerResponse, file: string, headers: Record<string, string>): Promise<void> {
  const stat = await fsp.stat(file).catch(() => null)
  if (!stat?.isFile()) return send(res, 404, 'Not found')
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': stat.size,
    ...headers
  })
  await pipeline(createReadStream(file), res)
}

class TooLarge extends Error {}

/** The request body, stopped once it passes `limit` bytes. */
async function* capped(req: IncomingMessage, limit: number): AsyncGenerator<Buffer> {
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > limit) throw new TooLarge()
    yield chunk as Buffer
  }
}

async function callIpc(req: IncomingMessage, res: ServerResponse, channel: string): Promise<void> {
  const handler = handlers.get(channel)
  if (!handler) return send(res, 404, `Unknown channel ${channel}`)
  let arg: unknown
  let file: string | undefined
  const filename = req.headers['x-kanbini-filename']
  const limit = limitFor(req.headers)
  try {
    if (Number(req.headers['content-length'] ?? 0) > limit) throw new TooLarge()
    if (typeof filename === 'string') {
      arg = JSON.parse(decodeURIComponent(String(req.headers['x-kanbini-arg'] ?? 'null')))
      // Keep the picked file's name: main takes the attachment name and extension from it.
      const name = basename(decodeURIComponent(filename))
      file = join(await fsp.mkdtemp(join(tmpdir(), 'kanbini-')), name === '.' || name === '..' || !name ? 'upload' : name)
      await pipeline(capped(req, limit), createWriteStream(file))
    } else {
      const chunks: Buffer[] = []
      for await (const chunk of capped(req, limit)) chunks.push(chunk)
      arg = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
    }
  } catch (err) {
    if (file) await fsp.rm(dirname(file), { recursive: true, force: true })
    if (!(err instanceof TooLarge)) return send(res, 400, 'Bad request')
    res.setHeader('connection', 'close') // don't read the rest of an oversized body
    return send(res, 413, `That's over the ${limit / 1024 / 1024} MB limit.`)
  }
  try {
    const result = await request.run({ file }, () => handler({ sender: null }, arg))
    send(res, 200, JSON.stringify(result ?? null), 'application/json')
  } catch (err) {
    send(res, 500, err instanceof Error ? err.message : String(err))
  } finally {
    if (file) await fsp.rm(dirname(file), { recursive: true, force: true })
  }
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://x').pathname

  if (path === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      // no-transform: stop Cloudflare compressing (and so buffering) the stream;
      // x-accel-buffering: stop nginx (Nginx Proxy Manager) buffering it.
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no'
    })
    res.write(': connected\n\n')
    events.add(res)
    req.on('close', () => events.delete(res))
    return
  }
  if (path.startsWith('/api/')) {
    if (req.method !== 'POST') return send(res, 405, 'POST only')
    return callIpc(req, res, decodeURIComponent(path.slice('/api/'.length)))
  }
  if (path.startsWith('/kanbini-file/')) {
    // main's handler confines the path to the attachment + background folders.
    const handler = protocols.get('kanbini-file')!
    const r = await handler({ url: `kanbini-file://${path.slice('/kanbini-file/'.length)}` } as Request)
    res.writeHead(r.status, {
      'content-type': r.headers.get('content-type') ?? 'text/plain',
      'content-security-policy': FILE_CSP,
      'x-content-type-options': 'nosniff',
      // File names carry a fresh id, so a path never changes content.
      ...(r.ok ? { 'cache-control': 'private, max-age=31536000, immutable' } : {})
    })
    return void res.end(Buffer.from(await r.arrayBuffer()))
  }
  if (path.startsWith('/download/')) {
    // shortcut: exports stay in <data>/downloads (small, overwritten per board name); add cleanup if it grows.
    const name = basename(decodeURIComponent(path.slice('/download/'.length)))
    return serveFile(res, join(app.getPath('userData'), 'downloads', name), {
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'cache-control': 'no-store'
    })
  }

  const file = resolve(webRoot, `.${path === '/' ? '/index.html' : decodeURIComponent(path)}`)
  if (!file.startsWith(webRoot + sep)) return send(res, 404, 'Not found')
  return serveFile(res, file, {
    // private: Cloudflare must not cache anything behind the password.
    'cache-control': path.startsWith('/assets/') ? 'private, max-age=31536000, immutable' : 'no-cache',
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff'
  })
}

const server = createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error('[web]', req.method, req.url, err)
    if (!res.headersSent) send(res, 500, 'Server error')
    else res.destroy()
  })
})
rmSync(socket, { force: true }) // left over if this account's app crashed
server.listen(socket, () => process.send?.('ready'))
