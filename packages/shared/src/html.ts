// Minimal HTML-entity decoder for the link-preview OG parser (ADR-0023,
// ADR-0057). Real-world `<meta og:title>` / `<title>` markup is
// HTML-escaped: numeric refs (`&#9917;` / `&#x26BD;` → ⚽) and a handful
// of named refs (`&amp;` `&#39;` `&quot;` …). The raw entity used to be
// stored verbatim in `attachment.sourceTitle`, so a card cover scraped
// from e.g. a Roblox page showed "[&#x26BD;] Soccer Incremental" instead
// of "[⚽] Soccer Incremental". We also decode the image URL so an
// `&amp;`-encoded query string resolves.
//
// Hand-rolled (no library) to keep the OG parser clean-room (ADR-0004)
// and dependency-light. Pure → unit-tested in @kanbini/shared. Covers
// the common named entities seen in page titles; anything unrecognised
// (or malformed) is left untouched rather than guessed at.

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  deg: '°',
  middot: '·',
  bull: '•',
  euro: '€',
  pound: '£',
  cent: '¢',
  yen: '¥',
  sect: '§',
  para: '¶'
}

/** Decode HTML entities in a string. Numeric (`&#NN;` / `&#xHH;`) and
 *  the common named entities are resolved; unknown or malformed
 *  references are returned verbatim. Idempotent on already-decoded text
 *  (a `&` not part of a `…;` reference is left as-is), so it's safe to
 *  run defensively at display time over values stored before the fetch
 *  side started decoding. */
export function decodeHtmlEntities(input: string): string {
  if (!input.includes('&')) return input
  return input.replace(
    /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (match, body: string) => {
      if (body.charCodeAt(0) === 35 /* '#' */) {
        const hex = body[1] === 'x' || body[1] === 'X'
        const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match
        try {
          return String.fromCodePoint(code)
        } catch {
          return match
        }
      }
      const named = NAMED_ENTITIES[body]
      return named !== undefined ? named : match
    }
  )
}
