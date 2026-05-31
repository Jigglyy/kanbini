import type { BoardView, LabelView } from './views'

// ADR-0042 · pure helpers for the Obsidian one-way push. Lives in
// `@kanbini/shared` (not the desktop main process) so the existing
// Vitest harness can cover the serialization, slugging, and
// foreign-file detection logic without touching the filesystem. The
// FS-touching push (`pushToObsidianVault`) lives in main and just
// glues these together.

/** Note format version emitted in the `kanbini.version` frontmatter
 *  field. Bumped whenever `buildNote`'s output shape changes in a way
 *  a downstream reader (e.g. a future re-importer or vault-linter)
 *  would care about. v2 added: `tags:`, `> [!info]` callout,
 *  wiki-links for board/list, dropped H1, empty-checklist skip. */
export const OBSIDIAN_NOTE_VERSION = 2 as const

/** Sanitize a string for use as a filesystem path segment. Strips
 *  characters Windows / macOS / Linux disagree about, collapses
 *  whitespace, lowercases, caps length. Empty input falls back to
 *  'untitled' so we never produce ".md". */
export function slugify(input: string): string {
  const s = input
    .normalize('NFKD')
    // Strip all the cross-platform-illegal characters in one pass.
    // Windows is the strict one: < > : " / \ | ? * + ASCII controls.
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s/g, '-')
    // Trim leading/trailing dots - Windows refuses files ending in '.'.
    .replace(/^\.+|\.+$/g, '')
  // Cap length so very long titles don't trip MAX_PATH on Windows.
  // 80 chars leaves room for the parent path + collision suffix +
  // `.md` extension well within the legacy 260-char ceiling.
  const trimmed = s.length > 80 ? s.slice(0, 80) : s
  // Windows reserves these device basenames REGARDLESS of extension -
  // a card titled "CON"/"NUL"/"COM1" slugs to `con`/`nul`/`com1`, and
  // `con.md` still resolves to the CON device, so the Obsidian push's
  // writeFile/rename would fail (or worse, target a device). Prefix
  // with `_` so the slug is always a real file name. (Anchored, so
  // ordinary titles like "console" / "company" are untouched.)
  const safe = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(trimmed)
    ? `_${trimmed}`
    : trimmed
  return safe || 'untitled'
}

/** Slug for an Obsidian `tags:` frontmatter entry. Stricter than
 *  `slugify` (which only strips Windows-illegal chars): Obsidian's
 *  tag grammar allows only [a-z0-9_/-], so any other character -
 *  punctuation, emoji, accented letters that NFKD didn't reduce to
 *  ASCII - collapses to a `-`. `untagged` is the fallback when the
 *  input has nothing reusable. */
export function slugifyTag(input: string): string {
  const s = input
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9_/]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'untagged'
}

/** Clean a string so it's safe inside `[[wiki-link]]` brackets.
 *  Obsidian's link parser breaks on `[`, `]`, `|`, `#`, `^` -
 *  strip them. Newlines obviously aren't allowed in a link. */
export function wikiLinkText(name: string): string {
  const safe = name
    .replace(/[\[\]|#^]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return safe || 'Untitled'
}

/** Human-readable relative form for a due date - "today", "tomorrow",
 *  "yesterday", "in N days", "N days ago". Snapshot value: computed
 *  at push time and embedded literally in the note, so it ages with
 *  the file. Day count uses UTC-day truncation; near-midnight drift
 *  by one day is acceptable for a snapshot. */
export function humanDueOffset(dueMs: number, nowMs: number): string {
  const dueDay = Math.floor(dueMs / 86_400_000)
  const nowDay = Math.floor(nowMs / 86_400_000)
  const diff = dueDay - nowDay
  if (diff === 0) return 'today'
  if (diff === 1) return 'tomorrow'
  if (diff === -1) return 'yesterday'
  if (diff > 0) return `in ${diff} days`
  return `${-diff} days ago`
}

/** Conservative YAML string quoting. Always single-quote when the
 *  string contains anything that could be parsed as a flow indicator,
 *  leading whitespace, leading `-`, leading digit, or a special YAML
 *  keyword. Escapes embedded single quotes by doubling them. */
export function yamlString(s: string): string {
  // A line break (or any C0 control char) can't live in a plain or
  // single-quoted YAML scalar - inside the flow-context arrays buildNote
  // emits (`aliases: [...]`, `labels: [...]`), a raw newline would split
  // the frontmatter line and corrupt the whole block. The next push's
  // `extractKanbiniId` would then read null and treat our own note as a
  // foreign user file (skip + warn) - permanently. Emit a double-quoted
  // scalar instead: JSON's escaping (\n, \t, \", \\, \uXXXX) is a valid
  // subset of YAML's double-quoted style. (Char-code scan rather than a
  // control-char regex - keeps the source free of literal control bytes.)
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 0x20) return JSON.stringify(s)
  }
  const needsQuotes =
    s.length === 0 ||
    /[:#&*!|>'"%@`,\[\]{}]/.test(s) ||
    /^\s|\s$/.test(s) ||
    /^-/.test(s) ||
    /^(true|false|null|yes|no|~)$/i.test(s) ||
    /^[\d-]/.test(s)
  if (!needsQuotes) return s
  return `'${s.replace(/'/g, "''")}'`
}

function priorityLabel(p: 'low' | 'medium' | 'high' | 'urgent'): string {
  return p[0]!.toUpperCase() + p.slice(1)
}

/** Build the .md body. Layout (v2):
 *    1. YAML frontmatter - the machine layer (`kanbini.*`, `tags`,
 *       `aliases`). Always present; the `kanbini.id` line is the
 *       marker the re-push safety check looks for.
 *    2. `> [!info]` Obsidian callout - the human layer. Wiki-linked
 *       board + list connect each card into the graph view; status /
 *       priority / due render as a single chip row.
 *    3. Description body (if any).
 *    4. Per-checklist task lists (skipped if the checklist is empty).
 *
 *  The duplicated `# {title}` H1 from v1 is gone - Obsidian uses the
 *  filename as the page title, and the `aliases:` frontmatter entry
 *  preserves the original casing for search. */
export function buildNote(opts: {
  card: BoardView['lists'][number]['cards'][number]
  list: BoardView['lists'][number]
  board: BoardView['board']
  labels: LabelView[]
  /** Snapshot time for the relative-due-date phrasing. Defaults to
   *  `Date.now()`; tests pin it for deterministic output. */
  now?: number
}): string {
  const { card, list, board, labels } = opts
  const now = opts.now ?? Date.now()
  const cardLabelNames = card.labelIds
    .map((id) => labels.find((l) => l.id === id)?.name)
    .filter((n): n is string => typeof n === 'string')
  const cardTags = cardLabelNames.map(slugifyTag)

  const lines: string[] = ['---', 'kanbini:']
  lines.push(`  id: ${card.id}`)
  lines.push(`  version: ${OBSIDIAN_NOTE_VERSION}`)
  lines.push(`  boardId: ${board.id}`)
  lines.push(`  boardName: ${yamlString(board.name)}`)
  lines.push(`  listName: ${yamlString(list.name)}`)
  lines.push(`  completed: ${card.completed}`)
  if (card.priority) lines.push(`  priority: ${card.priority}`)
  if (card.dueAt !== null) {
    lines.push(`  due: ${new Date(card.dueAt).toISOString()}`)
  }
  if (cardLabelNames.length > 0) {
    lines.push(
      `  labels: [${cardLabelNames.map((n) => yamlString(n)).join(', ')}]`
    )
  }
  if (card.attachments.length > 0) {
    // Attachment file copies are intentionally out of scope for v1
    // (vault would balloon, and Obsidian can't render kanbini-file://
    // URLs anyway). Surface the count so users at least know the
    // card has them.
    lines.push(`  attachmentCount: ${card.attachments.length}`)
  }
  if (card.checklists.length > 0) {
    lines.push(`  checklistCount: ${card.checklists.length}`)
  }
  if (cardTags.length > 0) {
    // Top-level `tags:` is Obsidian's standard frontmatter key - the
    // tag pane + graph view pick it up. `kanbini.labels` above still
    // carries the original casing for search; this is the renderable
    // mirror, slug-cased so it satisfies Obsidian's tag grammar.
    lines.push(`tags: [${cardTags.join(', ')}]`)
  }
  lines.push(`aliases: [${yamlString(card.title)}]`)
  lines.push('---')
  lines.push('')

  // Human-readable callout. The frontmatter above is the machine
  // layer; this is what a reader sees first. Wiki-linked board +
  // list names connect each card into Obsidian's graph view - broken
  // links still render + offer create-on-click, so the user doesn't
  // need to also create per-board / per-list notes for the graph to
  // light up.
  lines.push('> [!info]')
  lines.push(
    `> **Board:** [[${wikiLinkText(board.name)}]] · **List:** [[${wikiLinkText(list.name)}]]`
  )
  const facetBits: string[] = [
    `**Status:** ${card.completed ? 'Done' : 'Open'}`
  ]
  if (card.priority) {
    facetBits.push(`**Priority:** ${priorityLabel(card.priority)}`)
  }
  if (card.dueAt !== null) {
    const date = new Date(card.dueAt).toISOString().slice(0, 10)
    facetBits.push(
      `**Due:** ${date} (${humanDueOffset(card.dueAt, now)})`
    )
  }
  lines.push(`> ${facetBits.join(' · ')}`)
  lines.push('')

  if (card.description && card.description.trim().length > 0) {
    lines.push(card.description.trim())
    lines.push('')
  }
  // Skip checklists that have zero items - emitting a bare `## Name`
  // heading with nothing under it reads like a missing section.
  for (const cl of card.checklists) {
    if (cl.items.length === 0) continue
    lines.push(`## ${cl.name}`)
    lines.push('')
    for (const it of cl.items) {
      lines.push(`- [${it.completed ? 'x' : ' '}] ${it.text}`)
    }
    lines.push('')
  }

  // Collapse trailing blank-line runs to a single terminating newline.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  lines.push('')
  return lines.join('\n')
}

/** Pull the kanbini.id out of a file's leading frontmatter block.
 *  Returns null if the file doesn't open with `---` or the kanbini
 *  block isn't present. Tolerant of minor formatting differences;
 *  not a real YAML parser.
 *
 *  Normalisations:
 *   - Strips a leading UTF-8 BOM (some Windows editors save with one;
 *     the prefix check would otherwise reject our own files).
 *   - Converts CRLF → LF before parsing so the line-anchored regex
 *     doesn't depend on the platform that wrote the file. (Greedy
 *     `\s*` previously ate across the line break and the next
 *     `\r?\n` then had nothing to match - our own files survived
 *     because writeFile('utf8') emits LF, but a user-edited file
 *     re-saved with CRLF would have been treated as foreign.) */
export function extractKanbiniId(fileContent: string): string | null {
  const content = fileContent
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
  if (!content.startsWith('---')) return null
  const endIdx = content.indexOf('\n---', 3)
  if (endIdx === -1) return null
  const block = content.slice(0, endIdx)
  // `[ \t]*` (NOT `\s*`) on the kanbini: line so we don't accidentally
  // consume the line break and confuse the following `\n\s+id:`.
  // Tolerates 2-space or 4-space (or any whitespace) indent on the
  // id row, which is what `\s+` in the second half handles.
  const m = block.match(/^kanbini:[ \t]*\n\s+id:\s*(\S+)/m)
  return m ? m[1]! : null
}

/** Decide the leaf filename for a card. Returns the chosen filename;
 *  if a collision-suffix was applied, the FS-side caller's safety
 *  check at the resolved path will see whatever already lives there
 *  (our prior push, or a user file) and skip / overwrite accordingly. */
export function chooseFilename(
  baseSlug: string,
  takenBaseNames: ReadonlySet<string>
): string {
  let name = `${baseSlug}.md`
  let n = 2
  while (takenBaseNames.has(name)) {
    name = `${baseSlug}-${n}.md`
    n++
  }
  return name
}
