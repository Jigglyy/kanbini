import { describe, expect, it } from 'vitest'
import {
  OBSIDIAN_NOTE_VERSION,
  buildNote,
  chooseFilename,
  extractKanbiniId,
  humanDueOffset,
  shouldPruneNote,
  slugify,
  slugifyTag,
  wikiLinkText,
  yamlString
} from '../obsidian'
import type { BoardView, LabelView } from '../views'

// ADR-0042 · pure helpers for the Obsidian one-way push. FS-touching
// code lives in apps/desktop/src/main/obsidian-push.ts and isn't
// covered here - the contract these helpers expose is what the FS
// code stitches together.

describe('slugify', () => {
  it('lowercases + hyphenates + strips Windows-illegal chars', () => {
    expect(slugify('Hello World!')).toBe('hello-world!')
    // Windows: < > : " / \ | ? * + ASCII control chars
    expect(slugify('a/b:c|d?e*f<g>h"i\\j')).toBe('a-b-c-d-e-f-g-h-i-j')
  })

  it('collapses whitespace runs', () => {
    expect(slugify('  hello\t\tworld  ')).toBe('hello-world')
  })

  it("falls back to 'untitled' on empty or all-illegal input", () => {
    expect(slugify('')).toBe('untitled')
    expect(slugify('   ')).toBe('untitled')
    expect(slugify('///')).toBe('untitled')
  })

  it('trims leading + trailing dots (Windows refuses .-suffixed files)', () => {
    expect(slugify('...foo...')).toBe('foo')
    expect(slugify('.')).toBe('untitled')
  })

  it('caps very long inputs at 80 chars', () => {
    const long = 'a'.repeat(200)
    expect(slugify(long).length).toBe(80)
  })

  it('escapes Windows reserved device names so the slug is a real file', () => {
    // CON / NUL / COM1 etc. resolve to a DOS device REGARDLESS of
    // extension - `con.md` is still the CON device - so a card titled
    // "CON" must not slug to a bare reserved name (the Obsidian push
    // would fail or write to a device). Regression for the hunt.
    for (const reserved of ['CON', 'nul', 'PRN', 'aux', 'com1', 'LPT9']) {
      expect(slugify(reserved)).toBe(`_${reserved.toLowerCase()}`)
    }
  })

  it('leaves ordinary titles that merely START with a device name alone', () => {
    // The reserved check is anchored - only an exact match is escaped.
    expect(slugify('console')).toBe('console')
    expect(slugify('company')).toBe('company')
    expect(slugify('Nullable')).toBe('nullable')
    expect(slugify('com10')).toBe('com10')
  })
})

describe('slugifyTag', () => {
  it('lowercases + replaces non-tag chars with dashes', () => {
    expect(slugifyTag('Bug')).toBe('bug')
    expect(slugifyTag('P1')).toBe('p1')
    expect(slugifyTag('In Progress')).toBe('in-progress')
  })

  it('collapses repeated separators + trims', () => {
    expect(slugifyTag('--hello---world--')).toBe('hello-world')
    expect(slugifyTag('a !! b')).toBe('a-b')
  })

  it("falls back to 'untagged' when nothing tag-safe survives", () => {
    expect(slugifyTag('')).toBe('untagged')
    expect(slugifyTag('!!!')).toBe('untagged')
    // Emoji not reducible to ASCII via NFKD → stripped → empty.
    expect(slugifyTag('🐞')).toBe('untagged')
  })

  it('preserves `/` for Obsidian nested tags', () => {
    expect(slugifyTag('team/frontend')).toBe('team/frontend')
  })

  it('preserves `_` (Obsidian tag grammar allows it)', () => {
    expect(slugifyTag('work_in_progress')).toBe('work_in_progress')
  })
})

describe('wikiLinkText', () => {
  it('passes plain names through', () => {
    expect(wikiLinkText('My Board')).toBe('My Board')
    expect(wikiLinkText('To Do')).toBe('To Do')
  })

  it('strips chars that would break the wiki-link parser', () => {
    expect(wikiLinkText('a|b')).toBe('ab')
    expect(wikiLinkText('foo [bar]')).toBe('foo bar')
    expect(wikiLinkText('a#b')).toBe('ab')
    expect(wikiLinkText('caret^stuff')).toBe('caretstuff')
  })

  it('collapses internal whitespace runs', () => {
    expect(wikiLinkText('a   b\t\tc')).toBe('a b c')
  })

  it("falls back to 'Untitled' when nothing survives", () => {
    expect(wikiLinkText('|||')).toBe('Untitled')
    expect(wikiLinkText('  ')).toBe('Untitled')
  })
})

describe('humanDueOffset', () => {
  // Pin "now" to a recognisable midnight so day diffs are obvious.
  const NOW = Date.parse('2026-06-01T12:00:00Z')

  it('renders 0-day diff as "today"', () => {
    expect(humanDueOffset(Date.parse('2026-06-01T08:00:00Z'), NOW)).toBe(
      'today'
    )
    expect(humanDueOffset(Date.parse('2026-06-01T23:00:00Z'), NOW)).toBe(
      'today'
    )
  })

  it('renders ±1-day diff as "tomorrow" / "yesterday"', () => {
    expect(humanDueOffset(Date.parse('2026-06-02T00:00:00Z'), NOW)).toBe(
      'tomorrow'
    )
    expect(humanDueOffset(Date.parse('2026-05-31T23:00:00Z'), NOW)).toBe(
      'yesterday'
    )
  })

  it('renders future diff as "in N days"', () => {
    expect(humanDueOffset(Date.parse('2026-06-08T12:00:00Z'), NOW)).toBe(
      'in 7 days'
    )
  })

  it('renders past diff as "N days ago"', () => {
    expect(humanDueOffset(Date.parse('2026-05-15T12:00:00Z'), NOW)).toBe(
      '17 days ago'
    )
  })
})

describe('yamlString', () => {
  it('returns plain strings unquoted', () => {
    expect(yamlString('hello')).toBe('hello')
    expect(yamlString('my-board')).toBe('my-board')
  })

  it('quotes strings with YAML special chars', () => {
    expect(yamlString('a: b')).toBe("'a: b'")
    expect(yamlString('#hashtag')).toBe("'#hashtag'")
    expect(yamlString('a, b')).toBe("'a, b'")
  })

  it('quotes strings that could be YAML keywords', () => {
    expect(yamlString('true')).toBe("'true'")
    expect(yamlString('YES')).toBe("'YES'")
    expect(yamlString('null')).toBe("'null'")
  })

  it("doubles embedded single quotes (YAML's escape rule)", () => {
    expect(yamlString("it's fine")).toBe("'it''s fine'")
  })

  it('quotes leading-digit + leading-dash strings', () => {
    expect(yamlString('123 abc')).toBe("'123 abc'")
    expect(yamlString('-flag')).toBe("'-flag'")
  })

  it('quotes empty strings', () => {
    expect(yamlString('')).toBe("''")
  })

  it('escapes control chars (newlines/tabs) into a double-quoted scalar', () => {
    // Regression: a raw newline inside the single-quoted form would
    // split a `aliases: [...]`/`labels: [...]` frontmatter line in two
    // and corrupt the whole block. The double-quoted form keeps the
    // value on one physical line.
    const out = yamlString('line one\nline two')
    expect(out).not.toContain('\n') // no RAW newline survives
    expect(out).toBe('"line one\\nline two"')
    // Double-quoted YAML escaping is a superset of JSON's, so the
    // emitted scalar parses straight back to the original.
    expect(JSON.parse(out)).toBe('line one\nline two')
    expect(yamlString('tab\there')).toBe('"tab\\there"')
  })
})

describe('chooseFilename', () => {
  it('uses the base slug when the dir is empty', () => {
    expect(chooseFilename('foo', new Set())).toBe('foo.md')
  })

  it('suffixes -2 / -3 / … on collision', () => {
    const taken = new Set(['foo.md'])
    expect(chooseFilename('foo', taken)).toBe('foo-2.md')
    taken.add('foo-2.md')
    expect(chooseFilename('foo', taken)).toBe('foo-3.md')
  })

  it('skips already-occupied collision slots', () => {
    const taken = new Set(['foo.md', 'foo-2.md', 'foo-3.md'])
    expect(chooseFilename('foo', taken)).toBe('foo-4.md')
  })
})

describe('extractKanbiniId', () => {
  it('pulls the id from a well-formed frontmatter block', () => {
    const file = [
      '---',
      'kanbini:',
      '  id: 019e5c19-1fd',
      '  boardId: bbb',
      '---',
      '# Title',
      ''
    ].join('\n')
    expect(extractKanbiniId(file)).toBe('019e5c19-1fd')
  })

  it('returns null when the file has no frontmatter', () => {
    expect(extractKanbiniId('just a note\n')).toBeNull()
  })

  it('returns null when frontmatter has no kanbini block', () => {
    const file = ['---', 'title: User Note', 'tags: [a, b]', '---', ''].join(
      '\n'
    )
    expect(extractKanbiniId(file)).toBeNull()
  })

  it('returns null when kanbini block has no id', () => {
    const file = [
      '---',
      'kanbini:',
      '  boardId: bbb',
      '---',
      ''
    ].join('\n')
    expect(extractKanbiniId(file)).toBeNull()
  })

  it('tolerates 4-space indent', () => {
    const file = [
      '---',
      'kanbini:',
      '    id: 4-space-id',
      '---',
      ''
    ].join('\n')
    expect(extractKanbiniId(file)).toBe('4-space-id')
  })

  it('returns null on malformed (no closing ---)', () => {
    const file = '---\nkanbini:\n  id: x\nbody never ends'
    expect(extractKanbiniId(file)).toBeNull()
  })

  it('tolerates CRLF line endings (third-party editor save)', () => {
    // The naïve regex (greedy `\s*` after `kanbini:`) used to consume
    // `\r\n  ` across the line break and then fail to re-match `\n` for
    // the id line. Normalising CRLF → LF up front + `[ \t]*` instead
    // of `\s*` on the kanbini: line fixes both.
    const file =
      '---\r\nkanbini:\r\n  id: crlf-id\r\n---\r\nbody\r\n'
    expect(extractKanbiniId(file)).toBe('crlf-id')
  })

  it('tolerates a leading UTF-8 BOM', () => {
    // Some Windows editors stamp ﻿ at the start of saved files.
    // Without the BOM strip, startsWith('---') returns false and we'd
    // treat one of our own files as foreign on re-push.
    const file = '﻿---\nkanbini:\n  id: bom-id\n---\n'
    expect(extractKanbiniId(file)).toBe('bom-id')
  })
})

describe('shouldPruneNote', () => {
  const live = new Set(['card-1', 'card-2', 'card-3'])
  const written = new Map([
    ['card-1', '/vault/Kanbini/Board/card-one.md'],
    ['card-2', '/vault/Kanbini/Board/card-two.md']
  ])

  it('never touches foreign files (no kanbini.id)', () => {
    expect(
      shouldPruneNote(null, live, written, '/vault/Kanbini/Board/note.md')
    ).toBe(false)
  })

  it('prunes a note whose card no longer exists', () => {
    expect(
      shouldPruneNote(
        'deleted-card',
        live,
        written,
        '/vault/Kanbini/Board/old.md'
      )
    ).toBe(true)
  })

  it('prunes the OLD path of a card written elsewhere this push (rename)', () => {
    expect(
      shouldPruneNote(
        'card-1',
        live,
        written,
        '/vault/Kanbini/Board/old-title.md'
      )
    ).toBe(true)
  })

  it('keeps the note at its freshly-written path', () => {
    expect(
      shouldPruneNote(
        'card-1',
        live,
        written,
        '/vault/Kanbini/Board/card-one.md'
      )
    ).toBe(false)
  })

  it('keeps a live card that was NOT written this push (archived board / skip)', () => {
    expect(
      shouldPruneNote(
        'card-3',
        live,
        written,
        '/vault/Kanbini/Archived/still-here.md'
      )
    ).toBe(false)
  })
})

describe('buildNote (v2 format)', () => {
  // Pin a recognisable "now" so the relative due text is deterministic.
  const NOW = Date.parse('2026-06-01T12:00:00Z')
  const labels: LabelView[] = [
    { id: 'l1', name: 'Bug', color: '#f00' },
    { id: 'l2', name: 'P1', color: '#f80' }
  ]

  function makeCard(
    overrides: Partial<BoardView['lists'][number]['cards'][number]> = {}
  ): BoardView['lists'][number]['cards'][number] {
    return {
      id: 'c1',
      title: 'Card title',
      description: null,
      position: 'a0',
      completed: false,
      dueAt: null,
      priority: null,
      labelIds: [],
      checklists: [],
      comments: [],
      attachments: [],
      coverAttachmentId: null,
      activities: [],
      ...overrides
    }
  }
  const list = {
    id: 'list-1',
    name: 'To Do',
    color: null,
    closed: false,
    position: 'a0',
    wipLimit: null,
    sortMode: null,
    onEnter: null,
    cards: []
  }
  const board = {
    id: 'board-1',
    name: 'My Board',
    color: null,
    background: null,
    swimlaneMode: null
  }

  it('emits the version marker so future readers can detect format drift', () => {
    const out = buildNote({ card: makeCard(), list, board, labels, now: NOW })
    expect(out).toContain(`  version: ${OBSIDIAN_NOTE_VERSION}`)
    expect(OBSIDIAN_NOTE_VERSION).toBe(2)
  })

  it('produces a minimal note with frontmatter + callout + no body', () => {
    const out = buildNote({ card: makeCard(), list, board, labels, now: NOW })
    expect(out).toContain('---\nkanbini:\n  id: c1')
    expect(out).toContain('  boardName: My Board')
    expect(out).toContain('  listName: To Do')
    expect(out).toContain('  completed: false')
    expect(out).toContain('aliases: [Card title]')
    expect(out).toContain('> [!info]')
    expect(out).toContain('> **Board:** [[My Board]] · **List:** [[To Do]]')
    expect(out).toContain('> **Status:** Open')
  })

  it('drops the redundant `# Title` H1 (Obsidian uses the filename)', () => {
    const out = buildNote({ card: makeCard(), list, board, labels, now: NOW })
    expect(out).not.toContain('# Card title')
  })

  it('emits tags: frontmatter with slugified label names', () => {
    const out = buildNote({
      card: makeCard({ labelIds: ['l1', 'l2'] }),
      list,
      board,
      labels,
      now: NOW
    })
    expect(out).toContain('  labels: [Bug, P1]')
    expect(out).toContain('tags: [bug, p1]')
  })

  it('omits tags: when the card has no labels', () => {
    const out = buildNote({ card: makeCard(), list, board, labels, now: NOW })
    expect(out).not.toContain('\ntags:')
  })

  it('keeps the frontmatter intact when the title contains a newline', () => {
    // Regression for the hunt: a multi-line card title used to inject a
    // raw newline into the `aliases:` line, breaking the YAML block (and
    // the next push then mis-read our own note as a foreign file). The
    // aliases value must now stay on a single physical line and parse.
    const out = buildNote({
      card: makeCard({ title: 'multi\nline title' }),
      list,
      board,
      labels,
      now: NOW
    })
    const fmEnd = out.indexOf('\n---', 3)
    const frontmatter = out.slice(0, fmEnd)
    const aliasesLine = frontmatter
      .split('\n')
      .find((l) => l.startsWith('aliases:'))
    expect(aliasesLine).toBe('aliases: ["multi\\nline title"]')
    // id is still extractable after the round-trip-shaped corruption case
    expect(extractKanbiniId(out)).toBe('c1')
  })

  it('wiki-links board + list names inside the callout', () => {
    const out = buildNote({
      card: makeCard(),
      list: { ...list, name: 'In | Progress' },
      board: { ...board, name: 'Q4 [2026]' },
      labels,
      now: NOW
    })
    // | and [] removed by wikiLinkText so the link parser stays happy.
    expect(out).toContain('[[Q4 2026]]')
    expect(out).toContain('[[In Progress]]')
  })

  it('renders priority + due in the callout when set', () => {
    const dueMs = Date.parse('2026-06-08T12:00:00Z')
    const out = buildNote({
      card: makeCard({ priority: 'high', dueAt: dueMs }),
      list,
      board,
      labels,
      now: NOW
    })
    expect(out).toContain('**Priority:** High')
    expect(out).toContain('**Due:** 2026-06-08 (in 7 days)')
  })

  it('shows Status: Done for completed cards', () => {
    const out = buildNote({
      card: makeCard({ completed: true }),
      list,
      board,
      labels,
      now: NOW
    })
    expect(out).toContain('> **Status:** Done')
  })

  it('omits priority + due from the callout when not set', () => {
    const out = buildNote({ card: makeCard(), list, board, labels, now: NOW })
    expect(out).not.toContain('**Priority:**')
    expect(out).not.toContain('**Due:**')
  })

  it('keeps frontmatter machine fields (priority/due/labels/counts) when set', () => {
    const dueMs = Date.parse('2026-06-08T12:00:00Z')
    const out = buildNote({
      card: makeCard({
        completed: true,
        priority: 'high',
        dueAt: dueMs,
        labelIds: ['l1', 'l2'],
        checklists: [
          {
            id: 'cl1',
            name: 'Steps',
            position: 'a',
            items: [{ id: 'i1', text: 'x', completed: false, position: 'a' }]
          }
        ],
        attachments: [
          {
            id: 'a1',
            filename: 'pic.png',
            relPath: 'attachments/a1/pic.png',
            mime: 'image/png',
            size: 1,
            sourceUrl: null,
            sourceTitle: null,
            createdAt: 0
          }
        ]
      }),
      list,
      board,
      labels,
      now: NOW
    })
    expect(out).toContain('  completed: true')
    expect(out).toContain('  priority: high')
    expect(out).toContain(`  due: ${new Date(dueMs).toISOString()}`)
    expect(out).toContain('  labels: [Bug, P1]')
    expect(out).toContain('  attachmentCount: 1')
    expect(out).toContain('  checklistCount: 1')
  })

  it('renders the description body + checklist task lists', () => {
    const out = buildNote({
      card: makeCard({
        description: 'Hello **world**',
        checklists: [
          {
            id: 'cl1',
            name: 'Steps',
            position: 'a',
            items: [
              { id: 'i1', text: 'one', completed: true, position: 'a' },
              { id: 'i2', text: 'two', completed: false, position: 'b' }
            ]
          }
        ]
      }),
      list,
      board,
      labels,
      now: NOW
    })
    expect(out).toContain('Hello **world**')
    expect(out).toContain('## Steps')
    expect(out).toContain('- [x] one')
    expect(out).toContain('- [ ] two')
  })

  it('skips empty checklists so the note never carries a bare `## Name` heading', () => {
    const out = buildNote({
      card: makeCard({
        checklists: [
          { id: 'cl1', name: 'Empty', position: 'a', items: [] },
          {
            id: 'cl2',
            name: 'Filled',
            position: 'b',
            items: [{ id: 'i1', text: 'one', completed: false, position: 'a' }]
          }
        ]
      }),
      list,
      board,
      labels,
      now: NOW
    })
    expect(out).not.toContain('## Empty')
    expect(out).toContain('## Filled')
    expect(out).toContain('- [ ] one')
  })

  it('terminates with exactly one trailing newline (no blank-line spam)', () => {
    const out = buildNote({
      card: makeCard({ description: 'body' }),
      list,
      board,
      labels,
      now: NOW
    })
    // Output should end with "\n" but not "\n\n".
    expect(out.endsWith('\n')).toBe(true)
    expect(out.endsWith('\n\n')).toBe(false)
  })

  it('emits an id line that extractKanbiniId can read back', () => {
    const out = buildNote({
      card: makeCard({ id: 'roundtrip-id' }),
      list,
      board,
      labels,
      now: NOW
    })
    expect(extractKanbiniId(out)).toBe('roundtrip-id')
  })

  it('quotes board/list names that contain YAML specials', () => {
    const out = buildNote({
      card: makeCard(),
      list: { ...list, name: 'a: b' },
      board: { ...board, name: '#meta' },
      labels,
      now: NOW
    })
    expect(out).toContain("  boardName: '#meta'")
    expect(out).toContain("  listName: 'a: b'")
  })
})
