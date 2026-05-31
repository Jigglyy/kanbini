import { describe, expect, it } from 'vitest'
import { decodeHtmlEntities } from '../html'

// HTML-entity decoder for the link-preview OG parser (ADR-0057). The
// load-bearing case is the one the user hit: a Roblox page title that
// arrives as "[&#x26BD;] Soccer Incremental" must render the soccer
// ball, not the raw entity.

describe('decodeHtmlEntities', () => {
  it('decodes hex numeric refs (the Roblox soccer-ball case)', () => {
    expect(decodeHtmlEntities('[&#x26BD;] Soccer Incremental')).toBe(
      '[⚽] Soccer Incremental'
    )
  })

  it('decodes decimal numeric refs (0x26BD === 9917)', () => {
    expect(decodeHtmlEntities('&#9917; goal')).toBe('⚽ goal')
  })

  it('decodes astral codepoints (emoji) surrogate-safe', () => {
    expect(decodeHtmlEntities('&#x1F600; hi')).toBe('😀 hi')
  })

  it('decodes the common named entities', () => {
    expect(decodeHtmlEntities('Tom &amp; Jerry')).toBe('Tom & Jerry')
    expect(decodeHtmlEntities('&quot;quoted&quot;')).toBe('"quoted"')
    expect(decodeHtmlEntities('a &lt; b &gt; c')).toBe('a < b > c')
    expect(decodeHtmlEntities('she said &rsquo;hi&rsquo;')).toBe(
      'she said ’hi’'
    )
  })

  it('decodes &amp; inside an image query string', () => {
    expect(
      decodeHtmlEntities('https://x.com/i.jpg?a=1&amp;b=2&amp;c=3')
    ).toBe('https://x.com/i.jpg?a=1&b=2&c=3')
  })

  it('leaves unknown / malformed / semicolon-less references untouched', () => {
    expect(decodeHtmlEntities('AT&T')).toBe('AT&T') // no semicolon
    expect(decodeHtmlEntities('Tom & Jerry')).toBe('Tom & Jerry')
    expect(decodeHtmlEntities('&notareal;')).toBe('&notareal;') // unknown name
    expect(decodeHtmlEntities('&#xZZ;')).toBe('&#xZZ;') // bad hex
    expect(decodeHtmlEntities('&#999999999999;')).toBe('&#999999999999;') // out of range
  })

  it('is idempotent on already-decoded text + no-op without an ampersand', () => {
    expect(decodeHtmlEntities('[⚽] Soccer Incremental')).toBe(
      '[⚽] Soccer Incremental'
    )
    expect(decodeHtmlEntities('plain title')).toBe('plain title')
  })
})
