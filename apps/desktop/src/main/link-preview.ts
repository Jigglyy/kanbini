import { promises as fsp } from 'node:fs'
import { lookup } from 'node:dns/promises'
import { extname, join } from 'node:path'
import { Agent, fetch as undiciFetch } from 'undici'
import {
  decodeHtmlEntities,
  isPrivateOrReservedHost,
  makePinnedLookup,
  newId,
  type PinnedAddress
} from '@kanbini/shared'
import {
  type Db,
  applyMutationRecorded,
  createAttachment
} from '@kanbini/db'

// Link-preview fetcher (M4-H slice 4, ADR-0023). The ONLY outbound
// HTTP path in the app. Off by default - the renderer is responsible
// for gating on `settings.linkPreviews` before invoking the IPC; this
// module assumes the user has opted in and runs unconditionally when
// called.
//
// Flow:
//   1. Validate URL (http/https, length-capped).
//   2. Fetch the page HTML (timeout + byte cap, follows redirects).
//   3. Parse <meta og:image> + og:title (twitter: + <title> fallbacks).
//   4. Resolve image URL against the page URL, fetch it (timeout +
//      byte cap, content-type checked as image/*).
//   5. Write to userData/attachments/<id>/preview.<ext>; insert an
//      attachment row with sourceUrl + sourceTitle set.
//   6. Apply a card.update mutation to make the attachment the card's
//      cover. Caller broadcastChange()s.

const HTML_TIMEOUT_MS = 10_000
const IMAGE_TIMEOUT_MS = 15_000
const HTML_MAX_BYTES = 1 * 1024 * 1024 // 1 MB
const IMAGE_MAX_BYTES = 5 * 1024 * 1024 // 5 MB
const URL_MAX_LENGTH = 2048
const MAX_REDIRECTS = 5

const ALLOWED_IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|svg\+xml|avif)$/i
const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/avif': '.avif'
}

function ensureValidUrl(raw: string): URL {
  if (raw.length > URL_MAX_LENGTH) throw new Error('URL too long')
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('Invalid URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are allowed for link previews')
  }
  return parsed
}

/** An IP literal as the URL parser hands it to us: bracketed IPv6 or
 *  dotted-quad IPv4 (WHATWG normalises decimal/octal/hex v4 spellings
 *  to dotted-quad before we ever see them). */
function isIpLiteral(host: string): boolean {
  return host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
}

/** SSRF guard (ADR-0023). Refuse any URL whose host is a loopback /
 *  private / link-local / reserved address - either as a literal, or
 *  because the domain name RESOLVES to one (DNS-rebind defence). Run on
 *  the initial URL AND on every redirect target, because Node's `fetch`
 *  does not re-validate redirect hops. Without this, an attacker page
 *  could 302 a preview fetch at `http://127.0.0.1:<mcp-port>/` or the
 *  `169.254.169.254` cloud-metadata endpoint.
 *
 *  Returns the vetted addresses so the caller can PIN them into the
 *  socket's lookup (see makePinnedLookup). Checking alone leaves a
 *  TOCTOU: `fetch` re-resolves on connect, so a rebinding DNS server
 *  could answer public here and private a beat later. With the pin,
 *  the checked answer is the only one the connect can use. Empty
 *  array = the host is an IP literal (no DNS involved, no pin needed).
 *  A resolution failure now throws instead of falling through to an
 *  UNPINNED fetch - failing closed beats re-opening the race. */
async function assertFetchableUrl(parsed: URL): Promise<PinnedAddress[]> {
  const host = parsed.hostname
  if (isPrivateOrReservedHost(host)) {
    throw new Error('Link preview refused: host is private/loopback/reserved')
  }
  if (isIpLiteral(host)) return []
  let addrs
  try {
    addrs = await lookup(host, { all: true })
  } catch {
    throw new Error(`Link preview failed: could not resolve ${host}`)
  }
  for (const a of addrs) {
    if (isPrivateOrReservedHost(a.address)) {
      throw new Error(
        'Link preview refused: host resolves to a private/loopback address'
      )
    }
  }
  return addrs.map((a) => ({
    address: a.address,
    family: a.family === 6 ? 6 : 4
  }))
}

async function fetchWithCap(
  url: string,
  opts: { timeoutMs: number; maxBytes: number; accept: string }
): Promise<{ body: Buffer; mime: string | null }> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs)
  // Per-hop undici Agents whose connect.lookup answers only from the
  // vetted address list - closed in the finally once the body's read.
  const agents: Agent[] = []
  try {
    // Follow redirects MANUALLY so each hop is re-validated by
    // assertFetchableUrl - `redirect: 'follow'` would chase a 302 into
    // private space with no second check.
    let current = url
    let res!: Awaited<ReturnType<typeof undiciFetch>>
    for (let hop = 0; ; hop++) {
      const parsed = ensureValidUrl(current)
      const pins = await assertFetchableUrl(parsed)
      // Pin the vetted DNS answer into the socket for domain hosts so
      // the connect can't re-resolve to something private (rebind
      // TOCTOU). IP literals skip DNS entirely - nothing to pin.
      let dispatcher: Agent | undefined
      if (pins.length > 0) {
        dispatcher = new Agent({
          connect: { lookup: makePinnedLookup(pins) }
        })
        agents.push(dispatcher)
      }
      res = await undiciFetch(parsed.toString(), {
        signal: ac.signal,
        redirect: 'manual',
        headers: {
          // Be honest about who's calling - no browser spoof.
          'User-Agent': 'Kanbini/0.0 (+offline, opt-in link preview)',
          Accept: opts.accept
        },
        ...(dispatcher ? { dispatcher } : {})
      })
      const location = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && location) {
        if (hop >= MAX_REDIRECTS) throw new Error('Too many redirects')
        // Drain the redirect response so the socket can be reused/closed.
        await res.body?.cancel().catch(() => {})
        current = new URL(location, parsed).toString()
        continue
      }
      break
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    if (!res.body) throw new Error('No response body')
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    // Read manually so we can enforce a hard byte cap - fetch on its
    // own happily streams gigabytes if the server sends them.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > opts.maxBytes) {
        await reader.cancel().catch(() => {})
        throw new Error(`Response exceeds ${opts.maxBytes} bytes`)
      }
      chunks.push(value)
    }
    const mime = res.headers.get('content-type')?.split(';')[0]?.trim() ?? null
    return { body: Buffer.concat(chunks), mime }
  } finally {
    clearTimeout(timer)
    for (const a of agents) void a.close().catch(() => {})
  }
}

interface OgMeta {
  title: string | null
  image: string | null
}

/** Hand-written tag parser - no library needed and avoids pulling
 *  Planka-tainted code into the clean-room build (ADR-0004). Looks
 *  at <meta property|name="..."> for OG/twitter, then falls back to
 *  apple-touch-icon and <link rel="image_src"> so the long tail of
 *  pages without OG markup still finds something useable. The fallback
 *  order mirrors what every other unfurler does: og:image →
 *  twitter:image → schema.org itemprop → image_src → apple-touch-icon.
 *  Plain favicons (.ico) are intentionally skipped - our content-type
 *  allowlist rejects image/x-icon and they're usually too small to
 *  look good as a card cover anyway. */
function parseOg(html: string): OgMeta {
  let ogTitle: string | null = null
  let ogImage: string | null = null
  let twTitle: string | null = null
  let twImage: string | null = null
  let schemaImage: string | null = null
  let imageSrcLink: string | null = null
  let appleTouchIcon: string | null = null
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const htmlTitle = titleMatch?.[1]?.trim().replace(/\s+/g, ' ') ?? null

  const metaRe = /<meta\b([^>]+)>/gi
  let m: RegExpExecArray | null
  while ((m = metaRe.exec(html)) !== null) {
    const attrs = m[1]!
    const keyMatch =
      /(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i.exec(attrs)
    const contentMatch = /content\s*=\s*["']([^"']*)["']/i.exec(attrs)
    if (!keyMatch || !contentMatch) continue
    const key = keyMatch[1]!.toLowerCase()
    const value = contentMatch[1]!
    if (key === 'og:title') ogTitle = value
    else if (
      key === 'og:image' ||
      key === 'og:image:url' ||
      key === 'og:image:secure_url'
    )
      ogImage = value
    else if (key === 'twitter:title') twTitle = value
    else if (key === 'twitter:image' || key === 'twitter:image:src')
      twImage = value
    else if (key === 'image' && !schemaImage) schemaImage = value
  }

  const linkRe = /<link\b([^>]+)>/gi
  let l: RegExpExecArray | null
  while ((l = linkRe.exec(html)) !== null) {
    const attrs = l[1]!
    const relMatch = /rel\s*=\s*["']([^"']+)["']/i.exec(attrs)
    const hrefMatch = /href\s*=\s*["']([^"']*)["']/i.exec(attrs)
    if (!relMatch || !hrefMatch) continue
    const rels = relMatch[1]!.toLowerCase().split(/\s+/)
    const href = hrefMatch[1]!
    if (!href) continue
    if (rels.includes('image_src') && !imageSrcLink) imageSrcLink = href
    else if (
      (rels.includes('apple-touch-icon') ||
        rels.includes('apple-touch-icon-precomposed')) &&
      !appleTouchIcon
    )
      appleTouchIcon = href
  }

  // Decode HTML entities so the stored title reads naturally
  // ("[⚽] …" not "[&#x26BD;] …") and `&amp;`-encoded image query
  // strings resolve. Page <meta>/<title> markup is HTML-escaped.
  const rawTitle = (ogTitle ?? twTitle ?? htmlTitle)?.trim() || null
  const rawImage =
    ogImage ?? twImage ?? schemaImage ?? imageSrcLink ?? appleTouchIcon
  return {
    title: rawTitle ? decodeHtmlEntities(rawTitle) : null,
    image: rawImage ? decodeHtmlEntities(rawImage) : null
  }
}

export interface LinkPreviewSuccess {
  attachmentId: string
  boardId: string | null
  sourceUrl: string
  sourceTitle: string | null
}

export interface LinkPreviewOptions {
  db: Db
  attachmentsRoot: string
  cardId: string
  url: string
}

export async function createLinkPreviewAttachment(
  opts: LinkPreviewOptions
): Promise<LinkPreviewSuccess> {
  const parsed = ensureValidUrl(opts.url)

  // 1. Fetch HTML.
  const htmlRes = await fetchWithCap(parsed.toString(), {
    timeoutMs: HTML_TIMEOUT_MS,
    maxBytes: HTML_MAX_BYTES,
    accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5'
  })
  const html = htmlRes.body.toString('utf8')
  const meta = parseOg(html)
  if (!meta.image) {
    throw new Error('No preview image found on this page')
  }

  // 2. Resolve image URL + fetch.
  const imageUrl = new URL(meta.image, parsed).toString()
  ensureValidUrl(imageUrl) // belt-and-braces
  const imgRes = await fetchWithCap(imageUrl, {
    timeoutMs: IMAGE_TIMEOUT_MS,
    maxBytes: IMAGE_MAX_BYTES,
    accept: 'image/*'
  })
  if (!imgRes.mime || !ALLOWED_IMAGE_MIME.test(imgRes.mime)) {
    throw new Error(
      `Preview image content-type rejected: ${imgRes.mime ?? 'unknown'}`
    )
  }

  // 3. Save to userData/attachments/<id>/preview.<ext>.
  const id = newId()
  const ext =
    EXT_BY_MIME[imgRes.mime.toLowerCase()] ??
    (extname(new URL(imageUrl).pathname) || '.bin')
  const filename = `preview${ext}`
  const dir = join(opts.attachmentsRoot, id)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(join(dir, filename), imgRes.body)

  // 4. Insert attachment row, then make it the card's cover. Both
  // hit the same DB connection through the existing single-writer
  // service helpers - no new mutation type needed.
  const relPath = `attachments/${id}/${filename}`
  const created = createAttachment(opts.db, {
    id,
    cardId: opts.cardId,
    filename,
    relPath,
    mime: imgRes.mime,
    size: imgRes.body.byteLength,
    sourceUrl: parsed.toString(),
    sourceTitle: meta.title
  })
  // Route through the undo recorder (ADR-0036) so users can Ctrl+Z a
  // cover that was set automatically - same path as a manual cover.
  applyMutationRecorded(opts.db, {
    type: 'card.update',
    id: opts.cardId,
    patch: { coverAttachmentId: id }
  })

  return {
    attachmentId: created.id,
    boardId: created.boardId,
    sourceUrl: parsed.toString(),
    sourceTitle: meta.title
  }
}
