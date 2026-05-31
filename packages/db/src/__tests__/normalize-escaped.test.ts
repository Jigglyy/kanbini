import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyMutation, ensureDefaultProjectId } from '../crud'
import { getCardView } from '../data'
import { type Db } from '../client'
import { createTestDb } from './_setup'

// Migration 0010 back-fills AI-authored text stored with literal escape
// sequences (the MCP double-escape bug) into real line breaks. Runtime
// writes are fixed by decodeEscapedWhitespace; this proves the SQL that
// repairs pre-fix rows applies the SAME conservative rule. We seed
// "old" rows verbatim (applyMutation never decodes - that's the MCP
// boundary's job) then re-run the shipped migration SQL against them.
//
// In this source, '\\n' is a literal backslash + 'n' (two chars) -
// exactly the bytes a double-escaping client stored. '\n' is a real
// newline.

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATION = resolve(here, '../../drizzle/0010_normalize_escaped_text.sql')
const normalizeSql = readFileSync(MIGRATION, 'utf8')

let db: Db
let sqlite: Database.Database
let close: () => void
let cardId: string

beforeEach(() => {
  const t = createTestDb()
  db = t.db
  sqlite = t.sqlite
  close = t.close
  const projectId = ensureDefaultProjectId(db)
  const board = applyMutation(db, { type: 'board.create', projectId, name: 'B' })
  const list = applyMutation(db, {
    type: 'list.create',
    boardId: board.id,
    name: 'L'
  })
  const card = applyMutation(db, {
    type: 'card.create',
    listId: list.id,
    title: 'T'
  })
  cardId = card.id
})

afterEach(() => close())

/** Seed a comment verbatim (no decode) to mimic a row written before
 *  the fix, then return its id. */
function seedComment(body: string): string {
  const c = applyMutation(db, {
    type: 'comment.create',
    cardId,
    body,
    author: 'ai'
  })
  return c.id
}

/** Apply the real migration SQL (the `-->` breakpoint lines are SQL
 *  comments, so the whole file runs as one exec). */
function runMigration(): void {
  sqlite.exec(normalizeSql)
}

function bodyOf(commentId: string): string {
  const view = getCardView(db, cardId)!
  return view.comments.find((c) => c.id === commentId)!.body
}

describe('migration 0010 - normalize escaped text', () => {
  it('decodes a wholly-escaped comment body (the reported bug)', () => {
    const id = seedComment('Implemented.\\n\\n- one\\n- two')
    runMigration()
    expect(bodyOf(id)).toBe('Implemented.\n\n- one\n- two')
  })

  it('decodes \\r\\n and \\t escapes too', () => {
    const id = seedComment('a\\r\\nb\\tc')
    runMigration()
    expect(bodyOf(id)).toBe('a\nb\tc')
  })

  it('leaves a comment that already has a real newline untouched', () => {
    // Author used real breaks; a stray literal "\n" (e.g. inside code
    // they meant literally) must survive.
    const original = 'first line\nhas a literal \\n in code'
    const id = seedComment(original)
    runMigration()
    expect(bodyOf(id)).toBe(original)
  })

  it('leaves a plain single-line comment untouched', () => {
    const id = seedComment('just a normal comment')
    runMigration()
    expect(bodyOf(id)).toBe('just a normal comment')
  })

  it('decodes a wholly-escaped card description', () => {
    applyMutation(db, {
      type: 'card.update',
      id: cardId,
      patch: { description: 'Summary.\\n\\n- a\\n- b' }
    })
    runMigration()
    expect(getCardView(db, cardId)!.description).toBe('Summary.\n\n- a\n- b')
  })

  it('leaves a multi-line card description with real newlines untouched', () => {
    const original = '# Heading\n\nBody with a literal \\n token'
    applyMutation(db, {
      type: 'card.update',
      id: cardId,
      patch: { description: original }
    })
    runMigration()
    expect(getCardView(db, cardId)!.description).toBe(original)
  })

  it('is a no-op on a clean DB (re-running never double-decodes)', () => {
    const id = seedComment('Implemented.\\n\\n- one')
    runMigration()
    const once = bodyOf(id)
    runMigration() // second pass: row now has real newlines -> skipped
    expect(bodyOf(id)).toBe(once)
    expect(once).toBe('Implemented.\n\n- one')
  })
})
