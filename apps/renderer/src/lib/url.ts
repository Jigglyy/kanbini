// Tiny URL helpers shared between the card cover surface and the
// title auto-format (M4-H). No regex magic - `URL` for parsing, a
// permissive but bounded character class for the detect path.

/** Strip a URL down to "host.tld" for the in-card chip. Best-effort -
 *  bad inputs return null and the renderer falls back to no chip. */
export function domainOf(url: string): string | null {
  try {
    const u = new URL(url)
    return u.hostname.replace(/^www\./, '') || null
  } catch {
    return null
  }
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/i

/** First http(s) URL in a string, trimmed of trailing punctuation
 *  ("see https://example.com." → "https://example.com"). Returns
 *  null when no URL is present. */
export function detectFirstUrl(text: string): string | null {
  const m = URL_RE.exec(text)
  if (!m) return null
  return m[0].replace(/[.,;:!?)\]]+$/, '')
}
