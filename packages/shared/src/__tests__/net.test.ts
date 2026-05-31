import { describe, expect, it } from 'vitest'
import { isPrivateOrReservedHost } from '../net'

// SSRF guard classifier (ADR-0023). These ranges are the load-bearing
// part of the link-preview safety check - a regression here re-opens
// the door to fetching the user's loopback MCP channel, LAN devices, or
// the cloud metadata endpoint.

describe('isPrivateOrReservedHost', () => {
  it('blocks loopback IPv4 (127/8) + the unspecified 0.0.0.0', () => {
    expect(isPrivateOrReservedHost('127.0.0.1')).toBe(true)
    expect(isPrivateOrReservedHost('127.1.2.3')).toBe(true)
    expect(isPrivateOrReservedHost('0.0.0.0')).toBe(true)
  })

  it('blocks private IPv4 ranges (10/8, 172.16/12, 192.168/16)', () => {
    expect(isPrivateOrReservedHost('10.0.0.1')).toBe(true)
    expect(isPrivateOrReservedHost('172.16.0.1')).toBe(true)
    expect(isPrivateOrReservedHost('172.31.255.255')).toBe(true)
    expect(isPrivateOrReservedHost('192.168.1.1')).toBe(true)
    // Just OUTSIDE 172.16/12 - must stay allowed.
    expect(isPrivateOrReservedHost('172.15.0.1')).toBe(false)
    expect(isPrivateOrReservedHost('172.32.0.1')).toBe(false)
  })

  it('blocks link-local incl. the cloud metadata endpoint + CGNAT', () => {
    expect(isPrivateOrReservedHost('169.254.0.1')).toBe(true)
    expect(isPrivateOrReservedHost('169.254.169.254')).toBe(true) // AWS/GCP metadata
    expect(isPrivateOrReservedHost('100.64.0.1')).toBe(true) // CGNAT
    expect(isPrivateOrReservedHost('100.127.255.255')).toBe(true)
    expect(isPrivateOrReservedHost('100.63.0.1')).toBe(false) // just below CGNAT
    expect(isPrivateOrReservedHost('100.128.0.1')).toBe(false) // just above CGNAT
  })

  it('blocks localhost + the .localhost reserved TLD + empty host', () => {
    expect(isPrivateOrReservedHost('localhost')).toBe(true)
    expect(isPrivateOrReservedHost('LOCALHOST')).toBe(true)
    expect(isPrivateOrReservedHost('foo.localhost')).toBe(true)
    expect(isPrivateOrReservedHost('')).toBe(true)
  })

  it('blocks loopback/private/link-local IPv6 (with or without brackets)', () => {
    expect(isPrivateOrReservedHost('::1')).toBe(true)
    expect(isPrivateOrReservedHost('[::1]')).toBe(true)
    expect(isPrivateOrReservedHost('::')).toBe(true)
    expect(isPrivateOrReservedHost('fc00::1')).toBe(true) // ULA
    expect(isPrivateOrReservedHost('fd12:3456::1')).toBe(true) // ULA
    expect(isPrivateOrReservedHost('fe80::1')).toBe(true) // link-local
    expect(isPrivateOrReservedHost('[::ffff:127.0.0.1]')).toBe(true) // mapped loopback
  })

  it('allows public IP literals + ordinary domain names', () => {
    expect(isPrivateOrReservedHost('8.8.8.8')).toBe(false)
    expect(isPrivateOrReservedHost('1.1.1.1')).toBe(false)
    expect(isPrivateOrReservedHost('93.184.216.34')).toBe(false) // example.com
    expect(isPrivateOrReservedHost('example.com')).toBe(false)
    expect(isPrivateOrReservedHost('sub.domain.io')).toBe(false)
    expect(isPrivateOrReservedHost('2606:4700:4700::1111')).toBe(false) // public v6
  })
})
