// SSRF guard for the opt-in link-preview fetch (ADR-0023). The ONLY
// outbound HTTP path in the app must never be coaxed into reaching the
// user's own machine (the loopback MCP control channel, dev servers),
// the LAN, or a cloud metadata endpoint (169.254.169.254). This is the
// pure address classifier - it lives in @kanbini/shared (no node deps)
// so the existing Vitest harness can pin every range. The FS/DNS-side
// enforcement (resolve a domain name, re-check on every redirect hop)
// lives in apps/desktop/src/main/link-preview.ts and calls this.

function parseIpv4(h: string): [number, number, number, number] | null {
  const parts = h.split('.')
  if (parts.length !== 4) return null
  const nums: number[] = []
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    nums.push(n)
  }
  return nums as [number, number, number, number]
}

function isPrivateIpv4(ip: [number, number, number, number]): boolean {
  const [a, b] = ip
  if (a === 0) return true // 0.0.0.0/8 "this host"
  if (a === 10) return true // 10/8 private
  if (a === 127) return true // 127/8 loopback
  if (a === 169 && b === 254) return true // 169.254/16 link-local (incl. metadata)
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12 private
  if (a === 192 && b === 168) return true // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64/10 CGNAT
  if (a === 255 && b === 255) return true // broadcast-ish
  return false
}

/** Expand an IPv6 literal into its 8 16-bit groups, or null when the
 *  string isn't a valid IPv6 address. Handles `::` compression, an
 *  embedded dotted-quad tail (`::ffff:1.2.3.4`), and strips any `%zone`
 *  suffix. Needed because the WHATWG URL parser canonicalises IPv6
 *  hosts to the all-hex compressed form - `[::ffff:127.0.0.1]` arrives
 *  here as `::ffff:7f00:1`, so prefix string-matching alone misses the
 *  IPv4-mapped loopback (the bypass fixed in this revision). */
function parseIpv6Groups(host: string): number[] | null {
  let h = host
  const zone = h.indexOf('%')
  if (zone !== -1) h = h.slice(0, zone)
  // Convert a dotted-quad tail into its two hex groups so the rest of
  // the parser only deals with hex.
  const v4Tail = /^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(h)
  if (v4Tail) {
    const v4 = parseIpv4(v4Tail[2]!)
    if (!v4) return null
    const hi = ((v4[0] << 8) | v4[1]).toString(16)
    const lo = ((v4[2] << 8) | v4[3]).toString(16)
    h = `${v4Tail[1]}${hi}:${lo}`
  }
  const halves = h.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 && head.length !== 8) return null
  if (halves.length === 2 && missing < 1) return null
  const groups: number[] = []
  for (const part of [
    ...head,
    ...Array<string>(Math.max(0, missing)).fill('0'),
    ...tail
  ]) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null
    groups.push(parseInt(part, 16))
  }
  return groups.length === 8 ? groups : null
}

/** The IPv4 address embedded in an IPv4-in-IPv6 transition prefix, or
 *  null when `g` isn't one. Covers IPv4-mapped (`::ffff:0:0/96` - what
 *  dual-stack sockets actually route to the v4 loopback/LAN) and NAT64
 *  (`64:ff9b::/96` - a NAT64 gateway would translate it to the
 *  embedded v4). */
function embeddedIpv4(
  g: number[]
): [number, number, number, number] | null {
  const mapped =
    g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 &&
    g[5] === 0xffff
  const nat64 =
    g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 &&
    g[4] === 0 && g[5] === 0
  if (!mapped && !nat64) return null
  return [g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff]
}

function isPrivateIpv6(h: string): boolean {
  const g = parseIpv6Groups(h)
  // Unparseable but colon-bearing host: not a domain name (those never
  // contain ':'), so it's a malformed IPv6 literal - fail closed.
  if (!g) return true
  const v4 = embeddedIpv4(g)
  if (v4) return isPrivateIpv4(v4)
  const headZero = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 &&
    g[4] === 0 && g[5] === 0 && g[6] === 0
  if (headZero && g[7] === 0) return true // :: unspecified
  if (headZero && g[7] === 1) return true // ::1 loopback
  if ((g[0]! & 0xfe00) === 0xfc00) return true // fc00::/7 unique-local
  if ((g[0]! & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  return false
}

/** One vetted DNS answer for `makePinnedLookup`. */
export interface PinnedAddress {
  address: string
  family: 4 | 6
}

/** Build a `lookup`-compatible function (the option `net.connect` /
 *  `tls.connect` accept) that answers ONLY from the pre-vetted address
 *  list, never the real resolver. This closes the SSRF TOCTOU: the
 *  guard resolves + checks a domain's addresses, but a plain `fetch`
 *  then re-resolves on connect - a rebinding DNS server can pass the
 *  check and hand the connect a private address. Pinning makes the
 *  checked answer the only one the socket can use.
 *
 *  Typed structurally (no node imports) so this module stays
 *  dependency-free and unit-testable; the desktop main process feeds
 *  it into an undici Agent's `connect.lookup`. */
export function makePinnedLookup(
  addresses: PinnedAddress[]
): (
  hostname: string,
  options: { all?: boolean } | undefined,
  callback: (
    err: Error | null,
    address: string | Array<{ address: string; family: number }>,
    family?: number
  ) => void
) => void {
  return (_hostname, options, callback) => {
    if (addresses.length === 0) {
      callback(new Error('pinned lookup: no vetted addresses'), '')
      return
    }
    if (options?.all) {
      callback(
        null,
        addresses.map((a) => ({ address: a.address, family: a.family }))
      )
      return
    }
    const first = addresses[0]!
    callback(null, first.address, first.family)
  }
}

/** True when `host` (a URL hostname - an IP literal or a domain name)
 *  is a loopback / private / link-local / reserved address an opt-in
 *  link-preview fetch must never reach. Domain names return `false`
 *  here - the caller is expected to resolve them via DNS and re-run
 *  this check against each resolved IP (so a public name that points at
 *  a private address is still caught). `localhost`, the `.localhost`
 *  reserved TLD, and the empty host are blocked outright. */
export function isPrivateOrReservedHost(host: string): boolean {
  if (!host) return true
  let h = host.toLowerCase().trim()
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  // Strip IPv6 brackets (`[::1]` → `::1`) if a raw URL host was passed.
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  if (h.includes(':')) return isPrivateIpv6(h)
  const v4 = parseIpv4(h)
  if (v4) return isPrivateIpv4(v4)
  // A domain name - the caller resolves + re-checks the resolved IPs.
  return false
}
