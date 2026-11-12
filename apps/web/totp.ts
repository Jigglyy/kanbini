// Authenticator-app codes (TOTP, RFC 6238: HMAC-SHA1, 6 digits, 30 s steps).
import { createHmac } from 'node:crypto'

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Decodes the base32 secret authenticator apps are given. */
export function base32Decode(text: string): Buffer {
  let bits = ''
  for (const char of text.replace(/[\s=]/g, '').toUpperCase()) {
    const value = BASE32.indexOf(char)
    if (value < 0) throw new Error(`not base32: ${char}`)
    bits += value.toString(2).padStart(5, '0')
  }
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)))
}

export function base32Encode(bytes: Buffer): string {
  const bits = [...bytes].map((byte) => byte.toString(2).padStart(8, '0')).join('')
  return (bits.match(/.{1,5}/g) ?? []).map((chunk) => BASE32[parseInt(chunk.padEnd(5, '0'), 2)]).join('')
}

export const totpStep =(ms = Date.now()) => Math.floor(ms / 30_000)

export function totp(key: Buffer, step: number): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const hash = createHmac('sha1', key).update(counter).digest()
  const offset = hash[hash.length - 1]! & 0xf
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}
