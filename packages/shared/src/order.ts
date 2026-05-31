import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing'

// Fractional-index ordering (ADR-0011). A row's `position` is a short
// string; to place an item between two neighbours you mint a key
// strictly between their keys - only the moved row changes, no
// renumbering, no float drift. `null` means "before the first" /
// "after the last".

/** Key strictly between `a` and `b` (either may be null = open end). */
export function orderKeyBetween(a: string | null, b: string | null): string {
  return generateKeyBetween(a, b)
}

/** `n` evenly spaced keys strictly between `a` and `b` (bulk insert). */
export function orderKeysBetween(
  a: string | null,
  b: string | null,
  n: number
): string[] {
  return generateNKeysBetween(a, b, n)
}

/** First key for an empty ordered collection. */
export function firstOrderKey(): string {
  return generateKeyBetween(null, null)
}
