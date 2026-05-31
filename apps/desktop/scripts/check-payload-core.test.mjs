// ADR-0056 - unit tests for the pure helpers in
// check-payload-core.mjs. Uses node's built-in `node:test` runner
// + `node:assert` so the desktop workspace doesn't need a separate
// test harness (it's the only workspace without vitest, on purpose:
// most of its surface is integration-tested by `pnpm e2e` against
// the real Electron process).
//
// Run with: pnpm --filter @kanbini/desktop run test:scripts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  findMissingSentinels,
  parsePathListing
} from './check-payload-core.mjs'

// ─── parsePathListing ────────────────────────────────────────────

test('parsePathListing extracts every Path = line into the Set', () => {
  const stdout = [
    '----------',
    'Path = locales',
    'Size = 0',
    '',
    'Path = resources',
    'Size = 0',
    '',
    'Path = resources/app.asar',
    'Size = 1234'
  ].join('\n')
  const present = parsePathListing(stdout)
  assert.equal(present.size, 3)
  assert.ok(present.has('locales'))
  assert.ok(present.has('resources'))
  assert.ok(present.has('resources/app.asar'))
})

test('parsePathListing handles Windows CRLF line endings', () => {
  // This was the bug that bit us during development: splitting on
  // plain `\n` left a trailing `\r` on each line, and the `$`
  // end-of-line anchor refuses to match across `\r` (regex `.`
  // doesn't include it), so every Path entry silently failed to
  // parse and the Set came back empty.
  const stdout = 'Path = locales\r\nSize = 0\r\n\r\nPath = resources\r\n'
  const present = parsePathListing(stdout)
  assert.equal(present.size, 2)
  assert.ok(present.has('locales'))
  assert.ok(present.has('resources'))
})

test('parsePathListing normalises Windows backslashes to forward slashes', () => {
  // 7z reports archive paths with `\` on Windows. Sentinels in the
  // allow-list are written with `/` for readability - the parser
  // normalises so the comparison is a straight `Set.has()`.
  const stdout = [
    'Path = resources\\app.asar',
    'Path = resources\\app.asar.unpacked\\node_modules\\better-sqlite3'
  ].join('\n')
  const present = parsePathListing(stdout)
  assert.ok(present.has('resources/app.asar'))
  assert.ok(
    present.has(
      'resources/app.asar.unpacked/node_modules/better-sqlite3'
    )
  )
})

test('parsePathListing returns an empty Set when no Path lines present', () => {
  // Header-only listing (no archive entries) or empty input - the
  // caller treats a missing required sentinel as a failure, so an
  // empty Set is correct behaviour.
  assert.equal(parsePathListing('').size, 0)
  assert.equal(parsePathListing('Listing archive: foo.7z').size, 0)
  assert.equal(parsePathListing('\n\n\n').size, 0)
})

test('parsePathListing trims trailing whitespace from path values', () => {
  // Defensive: 7z output is typically tight but a trailing space
  // anywhere in the line would survive the regex capture without
  // the `.trim()` step. Pin the trim behaviour.
  const stdout = 'Path = resources/app.asar   '
  const present = parsePathListing(stdout)
  assert.ok(present.has('resources/app.asar'))
})

test('parsePathListing ignores lines that look like Path but are not section headers', () => {
  // A `Path` substring elsewhere in the output (e.g. a file named
  // "Path = something") shouldn't be picked up. Only lines that
  // START with `Path = ` count, per the `^` anchor.
  const stdout = [
    'Path = good',
    '  Path = indented-no-good',
    'PathLike = no'
  ].join('\n')
  const present = parsePathListing(stdout)
  assert.equal(present.size, 1)
  assert.ok(present.has('good'))
})

// ─── findMissingSentinels ────────────────────────────────────────

test('findMissingSentinels returns empty when every required is present', () => {
  const present = new Set([
    'resources/app.asar',
    'resources/NOTICES.md',
    'extra/stuff'
  ])
  const required = [
    'resources/app.asar',
    'resources/NOTICES.md'
  ]
  assert.deepEqual(findMissingSentinels(present, required), [])
})

test('findMissingSentinels lists missing entries in original required order', () => {
  // The diagnostic in the script prints these to the user; order
  // matters for readability + matching the documented sentinel list.
  const present = new Set(['resources/app.asar'])
  const required = [
    'resources/app.asar',
    'resources/NOTICES.md',
    'resources/mcp/index.js'
  ]
  assert.deepEqual(findMissingSentinels(present, required), [
    'resources/NOTICES.md',
    'resources/mcp/index.js'
  ])
})

test('findMissingSentinels returns all required when present is empty', () => {
  // The CRLF-parsing bug above made the parser produce empty Sets;
  // that bug + this case combined to report every sentinel as
  // missing on a perfectly-fine installer. The parser fix is the
  // root cause; this test pins the diff behaviour separately.
  const required = ['a', 'b', 'c']
  assert.deepEqual(
    findMissingSentinels(new Set(), required),
    required
  )
})

test('findMissingSentinels treats Set membership case-sensitively', () => {
  // Documentation-as-test: payload paths on Windows ARE
  // case-insensitive at the filesystem level (NTFS), but 7z reports
  // them as-written into the archive. Sentinels must match the
  // exact case the build produces. If a future build started
  // emitting `Resources/App.asar` instead, this would catch it
  // rather than silently pass.
  const present = new Set(['resources/app.asar'])
  assert.deepEqual(
    findMissingSentinels(present, ['Resources/App.asar']),
    ['Resources/App.asar']
  )
})
