import { describe, expect, it } from 'vitest'
import { newId } from '../id'

// UUIDv7 contract (ADR-0011): canonical 36-char lowercase, version
// nibble 7 in the third group, variant 8/9/a/b in the fourth. We
// don't pin the lib's specific bit layout beyond that - the schema is
// IETF-standardised and we just need to know the output is shaped
// like a real v7 so SQLite indexes stay friendly.
const UUIDV7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('newId', () => {
  it('returns a canonical-form UUIDv7 string', () => {
    const id = newId()
    expect(id).toHaveLength(36)
    expect(id).toMatch(UUIDV7_RE)
  })

  it('returns a unique id every call', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 1000; i++) ids.add(newId())
    expect(ids.size).toBe(1000)
  })

  it('produces ids whose lexicographic sort tracks creation time', async () => {
    // v7 prefixes with a 48-bit timestamp; ids minted in different
    // milliseconds must sort by creation order. Same-ms calls aren't
    // required to be monotonic (the lib doesn't promise that), so
    // sleep 2 ms between batches to put them in distinct buckets.
    const first = newId()
    await new Promise((r) => setTimeout(r, 2))
    const second = newId()
    await new Promise((r) => setTimeout(r, 2))
    const third = newId()
    expect([third, first, second].sort()).toEqual([first, second, third])
  })
})
