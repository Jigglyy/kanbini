import { expect, test } from 'vitest'
import { base32Decode, base32Encode, totp, totpStep } from './totp'

test('RFC 6238 SHA-1 vectors (last 6 digits)', () => {
  const key = base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
  expect(key.toString()).toBe('12345678901234567890')
  expect(totp(key, totpStep(59_000))).toBe('287082')
  expect(totp(key, totpStep(1_111_111_109_000))).toBe('081804')
  expect(totp(key, totpStep(2_000_000_000_000))).toBe('279037')
})

test('base32 encode: RFC 4648 vectors (unpadded) and round trip', () => {
  expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI')
  expect(base32Encode(Buffer.from('f'))).toBe('MY')
  const key = Buffer.from('0123456789abcdefghij')
  expect(base32Decode(base32Encode(key))).toEqual(key)
})

test('base32 accepts lower case, spaces and padding; rejects junk', () => {
  expect(base32Decode('gezd gnbv====')).toEqual(base32Decode('GEZDGNBV'))
  expect(() => base32Decode('GEZD1')).toThrow()
})
