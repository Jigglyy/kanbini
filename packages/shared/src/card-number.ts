// Card numbers: the short global #N people use to refer to a card
// ("move #142 to Done"). The DB assigns them (migration 0016); these are
// the pure rules every reader shares - parsing what a person typed,
// printing one, and numbering cards from an export written before
// numbers existed (the importer and the MCP headless reader must agree
// on that, so it lives here once).

/** At most 15 digits keeps every match a safe integer. */
const CARD_NUMBER_REF = /^#?(\d{1,15})$/

/** "#142" or "142" -> 142. Anything else (including 0, or a card id)
 *  -> null. Surrounding whitespace is ignored. */
export function parseCardNumberRef(s: string): number | null {
  const m = CARD_NUMBER_REF.exec(s.trim())
  if (!m) return null
  const n = Number(m[1])
  return n > 0 ? n : null
}

/** 142 -> "#142". */
export function formatCardNumber(n: number): string {
  return `#${n}`
}

/** Every card's number, filling in the ones that lack one: those are
 *  numbered in creation order (id breaks ties), starting after both the
 *  highest existing number and `last` (the counter), so a filled-in
 *  number never collides with a kept one. Same order as migration 0016
 *  used for existing cards. */
export function fillMissingCardNumbers(
  cards: ReadonlyArray<{ id: string; createdAt: number; number?: number | null }>,
  last = 0
): Map<string, number> {
  const out = new Map<string, number>()
  let next = last
  for (const c of cards) {
    if (c.number != null) {
      out.set(c.id, c.number)
      next = Math.max(next, c.number)
    }
  }
  const missing = cards
    .filter((c) => c.number == null)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (const c of missing) out.set(c.id, ++next)
  return out
}
