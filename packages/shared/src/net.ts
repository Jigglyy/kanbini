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

function isPrivateIpv6(h: string): boolean {
  if (h === '::1') return true // loopback
  if (h === '::') return true // unspecified
  if (/^f[cd]/.test(h)) return true // fc00::/7 unique-local
  if (/^fe[89ab]/.test(h)) return true // fe80::/10 link-local
  // IPv4-mapped (::ffff:a.b.c.d) - classify the embedded v4 tail.
  const mapped = /(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(h)
  if (mapped) {
    const v4 = parseIpv4(mapped[1]!)
    if (v4) return isPrivateIpv4(v4)
  }
  return false
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
