import { describe, expect, it } from 'vitest'
import { isPrivateOrReservedHost, makePinnedLookup } from '../net'

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

  it('blocks hex-form IPv4-mapped IPv6 (the WHATWG-canonical spelling)', () => {
    // `new URL('http://[::ffff:127.0.0.1]/').hostname` serialises to the
    // all-hex compressed form - the dotted spelling never reaches this
    // check in practice. Missing these was a full SSRF bypass.
    expect(isPrivateOrReservedHost('::ffff:7f00:1')).toBe(true) // 127.0.0.1
    expect(isPrivateOrReservedHost('[::ffff:7f00:1]')).toBe(true)
    expect(isPrivateOrReservedHost('::ffff:a9fe:a9fe')).toBe(true) // 169.254.169.254
    expect(isPrivateOrReservedHost('::ffff:a00:1')).toBe(true) // 10.0.0.1
    expect(isPrivateOrReservedHost('::ffff:c0a8:101')).toBe(true) // 192.168.1.1
    expect(isPrivateOrReservedHost('::ffff:808:808')).toBe(false) // 8.8.8.8 - public
  })

  it('blocks NAT64 (64:ff9b::/96) embedding a private IPv4', () => {
    expect(isPrivateOrReservedHost('64:ff9b::7f00:1')).toBe(true) // 127.0.0.1
    expect(isPrivateOrReservedHost('64:ff9b::a9fe:a9fe')).toBe(true) // metadata
    expect(isPrivateOrReservedHost('64:ff9b::808:808')).toBe(false) // 8.8.8.8
  })

  it('fails closed on malformed IPv6 literals and zone suffixes', () => {
    expect(isPrivateOrReservedHost(':::1')).toBe(true) // malformed
    expect(isPrivateOrReservedHost('1:2:3:4:5:6:7:8:9')).toBe(true) // 9 groups
    expect(isPrivateOrReservedHost('fe80::1%eth0')).toBe(true) // zone id
  })

  it('pinned lookup answers only from the vetted list', () => {
    const lookup = makePinnedLookup([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1::1', family: 6 }
    ])
    // Single-answer form (what net.connect uses by default).
    lookup('example.com', undefined, (err, address, family) => {
      expect(err).toBeNull()
      expect(address).toBe('93.184.216.34')
      expect(family).toBe(4)
    })
    // all:true form returns the full vetted set.
    lookup('example.com', { all: true }, (err, addresses) => {
      expect(err).toBeNull()
      expect(addresses).toEqual([
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1::1', family: 6 }
      ])
    })
  })

  it('pinned lookup errors instead of falling back to real DNS', () => {
    const lookup = makePinnedLookup([])
    lookup('example.com', undefined, (err) => {
      expect(err).toBeInstanceOf(Error)
    })
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
