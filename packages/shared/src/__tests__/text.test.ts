import { describe, expect, it } from 'vitest'
import { decodeEscapedWhitespace } from '../text'

// decodeEscapedWhitespace recovers line breaks from AI-authored text
// that arrived with the escape sequences written out literally (a
// whole comment body sent as "a\n\nb" instead of with real newlines).
// The guard is conservative: only decode when there's no real newline
// already present, so correctly-authored multi-line text is never
// touched. `\n` in the assertion strings below is a literal backslash +
// 'n' (two chars) wherever it's written `\\n` in the source.

describe('decodeEscapedWhitespace', () => {
  it('decodes a body that is wholly escaped (the reported bug)', () => {
    const input = 'Implemented.\\n\\n- **Packets.luau**\\n- DiceReceiver.client.luau'
    expect(decodeEscapedWhitespace(input)).toBe(
      'Implemented.\n\n- **Packets.luau**\n- DiceReceiver.client.luau'
    )
  })

  it('decodes a single escaped newline', () => {
    expect(decodeEscapedWhitespace('line one\\nline two')).toBe(
      'line one\nline two'
    )
  })

  it('decodes \\r\\n pairs to a single newline', () => {
    expect(decodeEscapedWhitespace('a\\r\\nb')).toBe('a\nb')
  })

  it('decodes a lone escaped carriage return to a newline', () => {
    expect(decodeEscapedWhitespace('a\\rb')).toBe('a\nb')
  })

  it('decodes escaped tabs', () => {
    expect(decodeEscapedWhitespace('a\\tb')).toBe('a\tb')
  })

  it('leaves text that already has a real newline untouched', () => {
    // Author used real breaks; a remaining literal "\n" (e.g. inside a
    // code span they meant literally) must survive.
    const input = 'first line\nsecond has a literal \\n in code'
    expect(decodeEscapedWhitespace(input)).toBe(input)
  })

  it('leaves text with a real carriage return untouched', () => {
    const input = 'first\rsecond \\n still literal'
    expect(decodeEscapedWhitespace(input)).toBe(input)
  })

  it('returns single-line text with no escapes unchanged', () => {
    expect(decodeEscapedWhitespace('just a normal comment')).toBe(
      'just a normal comment'
    )
  })

  it('is idempotent on already-decoded text', () => {
    const once = decodeEscapedWhitespace('a\\nb')
    expect(decodeEscapedWhitespace(once)).toBe(once)
    expect(once).toBe('a\nb')
  })

  it('returns the empty string unchanged', () => {
    expect(decodeEscapedWhitespace('')).toBe('')
  })
})
