import { describe, expect, it } from 'vitest'
import { detectFirstUrl, domainOf } from '../url'

// Pure-helper coverage for the auto-cover / URL-chip surface (M4-H).
// Both functions are best-effort: bad input → null, never throws.

describe('domainOf', () => {
  it('returns the hostname with www. stripped', () => {
    expect(domainOf('https://example.com/path')).toBe('example.com')
    expect(domainOf('https://www.example.com/path')).toBe('example.com')
    expect(domainOf('http://docs.kanbini.app/')).toBe('docs.kanbini.app')
  })

  it('keeps non-www subdomains intact', () => {
    expect(domainOf('https://api.example.com/v1/users')).toBe('api.example.com')
    expect(domainOf('https://wwwxyz.example.com')).toBe('wwwxyz.example.com')
  })

  it('returns null for non-URL input', () => {
    expect(domainOf('not a url')).toBeNull()
    expect(domainOf('')).toBeNull()
    expect(domainOf('example.com')).toBeNull() // missing scheme
  })

  it('handles ports + auth + fragments', () => {
    expect(domainOf('https://example.com:8080/a')).toBe('example.com')
    expect(domainOf('https://user:pass@example.com/')).toBe('example.com')
    expect(domainOf('https://example.com/#section')).toBe('example.com')
  })
})

describe('detectFirstUrl', () => {
  it('finds the first http or https URL in text', () => {
    expect(detectFirstUrl('see https://example.com for details')).toBe(
      'https://example.com'
    )
    expect(detectFirstUrl('plain http://x.com')).toBe('http://x.com')
  })

  it('returns null when no URL is present', () => {
    expect(detectFirstUrl('')).toBeNull()
    expect(detectFirstUrl('just words')).toBeNull()
    expect(detectFirstUrl('ftp://nope.com')).toBeNull() // only http(s)
  })

  it('trims trailing punctuation a user is likely to type', () => {
    // Common sentence-end characters that would otherwise become part
    // of the URL: . , ; : ! ? ) ]
    expect(detectFirstUrl('see https://example.com.')).toBe('https://example.com')
    expect(detectFirstUrl('check https://example.com!')).toBe(
      'https://example.com'
    )
    expect(detectFirstUrl('docs (https://example.com) here')).toBe(
      'https://example.com'
    )
    expect(detectFirstUrl('mid-sentence https://example.com, then more')).toBe(
      'https://example.com'
    )
  })

  it('returns only the FIRST URL in a multi-URL string', () => {
    expect(detectFirstUrl('a https://one.com b https://two.com')).toBe(
      'https://one.com'
    )
  })

  it('handles URLs with paths, query strings, and fragments', () => {
    expect(
      detectFirstUrl('go https://example.com/path?q=1&r=2#section here')
    ).toBe('https://example.com/path?q=1&r=2#section')
  })

  it('is case-insensitive on the scheme', () => {
    expect(detectFirstUrl('see HTTPS://Example.com')).toBe(
      'HTTPS://Example.com'
    )
  })

  it("stops at whitespace + quote-like characters (won't gobble surrounding markup)", () => {
    expect(detectFirstUrl('<a href="https://example.com">link</a>')).toBe(
      'https://example.com'
    )
  })
})
