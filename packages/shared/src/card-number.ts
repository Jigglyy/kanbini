// Card numbers: the short #N people use to refer to a card ("move #142
// to Done"), counted per board. The DB assigns them (migrations 0016,
// 0017); these are the pure rules every reader shares - parsing what a
// person typed, printing one, numbering the cards of an export, and the
// error for a number given without its board (the importer, the live
// reader and the MCP headless reader must agree on those, so they live
// here once).

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

/** The error for a card number looked up without a board. Numbers are
 *  per board, so "#12" alone names one card on each board that has a
 *  #12; the message lists them so the caller can retry with one. */
export function cardNumberNeedsBoardMessage(
  n: number,
  boards: ReadonlyArray<{ id: string; name: string }>
): string {
  const ref = formatCardNumber(n)
  const which =
    boards.length === 0
      ? `No board has a card ${ref}.`
      : `Boards with a card ${ref}: ${boards.map((b) => `"${b.name}" (${b.id})`).join(', ')}.`
  return `Card numbers are per board: pass boardId to look up ${ref}. ${which}`
}

/** True when an export's boards carry their own card counters, i.e. it
 *  was written after numbers became per board (migration 0017). Card
 *  numbers in any older export came from one counter shared by every
 *  board (or don't exist), so they are not kept. */
export function hasPerBoardCardNumbers(
  boards: ReadonlyArray<{ cardNumberLast?: number | null }>
): boolean {
  return boards.every((b) => b.cardNumberLast != null)
}

/** Every card's number in an export, filled in the same way by the
 *  importer and the MCP headless reader. In a per-board export, a card
 *  that has a number keeps it and the rest are numbered after both
 *  their board's highest kept number and its counter, so a filled-in
 *  number never collides with a kept one. An older export is
 *  renumbered per board from 1, which is what migration 0017 does to a
 *  live database. Either way the cards being numbered go in creation
 *  order, id breaking ties. Cards whose list isn't in the export are
 *  numbered together, as if on one board. */
export function fillMissingCardNumbers(dump: {
  boards: ReadonlyArray<{ id: string; cardNumberLast?: number | null }>
  lists: ReadonlyArray<{ id: string; boardId: string }>
  cards: ReadonlyArray<{ id: string; listId: string; createdAt: number; number?: number | null }>
}): Map<string, number> {
  const keep = hasPerBoardCardNumbers(dump.boards)
  const boardOfList = new Map(dump.lists.map((l) => [l.id, l.boardId]))
  const next = new Map<string, number>()
  if (keep) for (const b of dump.boards) next.set(b.id, b.cardNumberLast ?? 0)
  const out = new Map<string, number>()
  const missing: Array<{ id: string; boardId: string; createdAt: number }> = []
  for (const c of dump.cards) {
    const boardId = boardOfList.get(c.listId) ?? ''
    if (keep && c.number != null) {
      out.set(c.id, c.number)
      next.set(boardId, Math.max(next.get(boardId) ?? 0, c.number))
    } else {
      missing.push({ id: c.id, boardId, createdAt: c.createdAt })
    }
  }
  missing.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (const c of missing) {
    const n = (next.get(c.boardId) ?? 0) + 1
    next.set(c.boardId, n)
    out.set(c.id, n)
  }
  return out
}
