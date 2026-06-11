import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyMutation, ensureDefaultProjectId } from '../crud'
import { searchCards } from '../search'
import { type Db } from '../client'
import { createTestDb } from './_setup'

// searchCards is the global Ctrl/Cmd+F surface (M4-D, ADR-0030).
// What we lock in here:
//   • empty query → []
//   • title / description / label hits all surface
//   • sort tier: title (0) → label (1) → description (2)
//   • ties break by updatedAt desc
//   • archived cards + closed lists are excluded
//   • cap is honoured

let db: Db
let close: () => void

beforeEach(() => {
  const t = createTestDb()
  db = t.db
  close = t.close
})
afterEach(() => close())

function seed(): { board1: string; board2: string } {
  const projectId = ensureDefaultProjectId(db)
  const b1 = applyMutation(db, {
    type: 'board.create',
    projectId,
    name: 'B1'
  }).id
  const l1 = applyMutation(db, {
    type: 'list.create',
    boardId: b1,
    name: 'L1'
  }).id
  const b2 = applyMutation(db, {
    type: 'board.create',
    projectId,
    name: 'B2'
  }).id
  const l2 = applyMutation(db, {
    type: 'list.create',
    boardId: b2,
    name: 'L2'
  }).id

  // Title hit on b1.
  applyMutation(db, { type: 'card.create', listId: l1, title: 'Find me' })
  // Description hit on b2.
  const descHit = applyMutation(db, {
    type: 'card.create',
    listId: l2,
    title: 'Plain'
  }).id
  applyMutation(db, {
    type: 'card.update',
    id: descHit,
    patch: { description: 'has find me in the body' }
  })
  // Label hit on b1.
  const labCard = applyMutation(db, {
    type: 'card.create',
    listId: l1,
    title: 'Labeled'
  }).id
  const lab = applyMutation(db, {
    type: 'label.create',
    boardId: b1,
    name: 'find me label',
    color: '#fff'
  }).id
  applyMutation(db, {
    type: 'card.setLabels',
    id: labCard,
    labelIds: [lab]
  })

  return { board1: b1, board2: b2 }
}

describe('searchCards', () => {
  it('returns [] for an empty / whitespace query', () => {
    seed()
    expect(searchCards(db, '')).toEqual([])
    expect(searchCards(db, '   ')).toEqual([])
  })

  it('surfaces title + description + label hits and orders title → label → description', () => {
    seed()
    const hits = searchCards(db, 'find me')
    // Three distinct cards matched once each via different surfaces.
    expect(hits).toHaveLength(3)
    const kinds = hits.map((h) => h.matchKind)
    expect(kinds[0]).toBe('title')
    expect(kinds[1]).toBe('label')
    expect(kinds[2]).toBe('description')
  })

  it('attaches descriptionSnippet only when description matched', () => {
    seed()
    const hits = searchCards(db, 'find me')
    const titleHit = hits.find((h) => h.matchKind === 'title')!
    const descHit = hits.find((h) => h.matchKind === 'description')!
    expect(titleHit.descriptionSnippet).toBeNull()
    expect(descHit.descriptionSnippet).toContain('find me')
  })

  it('attaches matchedLabels only when a label matched', () => {
    seed()
    const hits = searchCards(db, 'find me')
    const labelHit = hits.find((h) => h.matchKind === 'label')!
    expect(labelHit.matchedLabels).toEqual(['find me label'])
    const titleHit = hits.find((h) => h.matchKind === 'title')!
    expect(titleHit.matchedLabels).toEqual([])
  })

  it('excludes archived cards and closed lists', () => {
    const { board1 } = seed()
    // Add a card that matches 'find me' in a fresh list, then close
    // the list - the hit must drop.
    const closedList = applyMutation(db, {
      type: 'list.create',
      boardId: board1,
      name: 'Closed'
    }).id
    applyMutation(db, {
      type: 'card.create',
      listId: closedList,
      title: 'find me in a closed list'
    })
    const beforeClose = searchCards(db, 'closed list')
    expect(beforeClose).toHaveLength(1)
    applyMutation(db, {
      type: 'list.update',
      id: closedList,
      patch: { closed: true }
    })
    expect(searchCards(db, 'closed list')).toHaveLength(0)
  })

  it('respects the limit (cap)', () => {
    const projectId = ensureDefaultProjectId(db)
    const b = applyMutation(db, {
      type: 'board.create',
      projectId,
      name: 'B'
    }).id
    const l = applyMutation(db, {
      type: 'list.create',
      boardId: b,
      name: 'L'
    }).id
    for (let i = 0; i < 5; i++) {
      applyMutation(db, {
        type: 'card.create',
        listId: l,
        title: `match ${i}`
      })
    }
    expect(searchCards(db, 'match', 3)).toHaveLength(3)
    expect(searchCards(db, 'match', 50)).toHaveLength(5)
  })

  // The query is interpolated into a LIKE pattern with no escape,
  // so SQL wildcards in the user's query bleed through (`%` matches
  // anything, `_` any one char). Probably not worth fixing - kanban
  // search queries with literal `%` / `_` are rare and the surprise
  // is mild - but pin the behaviour here so we don't ship a silent
  // change. If we ever want exact-substring on these characters,
  // escape them and add `ESCAPE '\\'` to the LIKE clauses in search.ts.
  it('excludes cards on archived boards', () => {
    const projectId = ensureDefaultProjectId(db)
    const b = applyMutation(db, {
      type: 'board.create',
      projectId,
      name: 'Old board'
    }).id
    const l = applyMutation(db, {
      type: 'list.create',
      boardId: b,
      name: 'L'
    }).id
    applyMutation(db, { type: 'card.create', listId: l, title: 'findable' })
    expect(searchCards(db, 'findable')).toHaveLength(1)

    applyMutation(db, {
      type: 'board.update',
      id: b,
      patch: { archived: true }
    })
    // The home screen hides archived boards by default - search must
    // not surface a hidden surface either.
    expect(searchCards(db, 'findable')).toHaveLength(0)
  })

  it('treats SQL LIKE metacharacters in the query as literals', () => {
    const projectId = ensureDefaultProjectId(db)
    const b = applyMutation(db, {
      type: 'board.create',
      projectId,
      name: 'B'
    }).id
    const l = applyMutation(db, {
      type: 'list.create',
      boardId: b,
      name: 'L'
    }).id
    applyMutation(db, { type: 'card.create', listId: l, title: 'Done 50ANYTHING' })
    applyMutation(db, { type: 'card.create', listId: l, title: 'Progress: 50%' })
    applyMutation(db, { type: 'card.create', listId: l, title: 'snake_case task' })
    applyMutation(db, { type: 'card.create', listId: l, title: 'snake-case task' })
    applyMutation(db, { type: 'card.create', listId: l, title: 'C:\\paths\\too' })

    // `%` is a literal percent sign, not "match anything".
    expect(searchCards(db, '50%').map((h) => h.title)).toEqual(['Progress: 50%'])
    // `_` is a literal underscore, not the single-char wildcard.
    expect(searchCards(db, 'snake_').map((h) => h.title)).toEqual([
      'snake_case task'
    ])
    // The escape character itself round-trips as a literal too.
    expect(searchCards(db, '\\paths').map((h) => h.title)).toEqual([
      'C:\\paths\\too'
    ])
  })

  it('match is case-insensitive', () => {
    const projectId = ensureDefaultProjectId(db)
    const b = applyMutation(db, {
      type: 'board.create',
      projectId,
      name: 'B'
    }).id
    const l = applyMutation(db, {
      type: 'list.create',
      boardId: b,
      name: 'L'
    }).id
    applyMutation(db, { type: 'card.create', listId: l, title: 'UPPER' })
    expect(searchCards(db, 'upper')).toHaveLength(1)
    expect(searchCards(db, 'UpP')).toHaveLength(1)
  })
})
