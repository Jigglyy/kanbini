import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_CODENAME, localDayStart, type Mutation } from '@kanbini/shared'
import {
  applyMutation,
  applyMutationRecorded,
  exportToFolder,
  getAgenda,
  getArchivedItems,
  getBoardView,
  getCardView,
  listBoards,
  openDatabase,
  searchCards,
  seedSampleData,
  type Db
} from '@kanbini/db'
import {
  headlessAgenda,
  headlessArchivedItems,
  headlessBoardView,
  headlessCardView,
  headlessListBoards,
  headlessSearchCards,
  loadHeadlessSnapshot
} from '../headless'

// Headless read-only fallback (MCP polish). Two layers of coverage:
//
//   1. Unit comparison vs the live `@kanbini/db` view functions on
//      a populated DB → catches drift between the headless reader
//      and the source-of-truth view shapes. Any new column or
//      sorting change in `@kanbini/db/data.ts` must be mirrored in
//      `apps/mcp/src/headless.ts` or this suite fails.
//
//   2. Integration: spawn the real MCP bundle with no mcp.json on
//      disk but a populated export folder → exercise the actual
//      readWithFallback wire-up so the wrapping prefix + the path
//      from rpc-throw → snapshot-load → tool-result stay correct.

const here = dirname(fileURLToPath(import.meta.url))
// __tests__/headless.test.ts → packages/db/drizzle
const MIGRATIONS = resolve(here, '../../../../packages/db/drizzle')
// __tests__/headless.test.ts → apps/mcp/dist/index.js (built by pretest)
const SERVER_PATH = resolve(here, '../../dist/index.js')

if (!existsSync(SERVER_PATH)) {
  throw new Error(
    `MCP bundle missing at ${SERVER_PATH}. Run \`pnpm --filter @kanbini/mcp run build\` first.`
  )
}

let tmpRoot: string
/** Temp `<APP_CODENAME>` directory the MCP server points at via
 *  KANBINI_USERDATA_OVERRIDE. No `mcp.json` is written here, so
 *  loadDiscovery returns null and read tools fall back to the export. */
let userDataDir: string
let exportDir: string
let db: Db
let closeDb: () => void

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'kanbini-mcp-headless-'))
  userDataDir = join(tmpRoot, APP_CODENAME)
  exportDir = join(userDataDir, 'export')
  await mkdir(userDataDir, { recursive: true })

  const opened = openDatabase({
    filePath: ':memory:',
    migrationsFolder: MIGRATIONS
  })
  db = opened.db
  closeDb = opened.close
  seedSampleData(db)

  // Route one mutation through applyMutationRecorded so at least one
  // card has activity rows + a description in the export. Without
  // this every seeded card has zero activities (seeds use direct
  // drizzle writes), which is fine for the shape comparison but
  // makes for thinner test coverage of activity ordering.
  const board = getBoardView(db)!
  const firstCard = board.lists[0]!.cards[0]!
  applyMutationRecorded(db, {
    type: 'card.update',
    id: firstCard.id,
    patch: { description: '# Heading\n\nBody text with **bold** markdown.' }
  } as Mutation)
  applyMutationRecorded(db, {
    type: 'card.update',
    id: firstCard.id,
    patch: { priority: 'high' }
  } as Mutation)

  await exportToFolder(db, userDataDir, exportDir)
}, 30_000)

afterAll(async () => {
  closeDb?.()
  await rm(tmpRoot, { recursive: true, force: true })
})

describe('headless readers vs live @kanbini/db', () => {
  it('headlessListBoards matches listBoards row-for-row', async () => {
    const snap = await loadHeadlessSnapshot(exportDir)
    expect(snap).not.toBeNull()
    expect(headlessListBoards(snap!)).toEqual(listBoards(db))
  })

  it('headlessBoardView (default - first board) matches getBoardView()', async () => {
    const snap = await loadHeadlessSnapshot(exportDir)
    expect(headlessBoardView(snap!)).toEqual(getBoardView(db))
  })

  it('headlessBoardView by id matches getBoardView(id)', async () => {
    const snap = await loadHeadlessSnapshot(exportDir)
    const id = listBoards(db)[0]!.id
    expect(headlessBoardView(snap!, id)).toEqual(getBoardView(db, id))
  })

  it('headlessBoardView returns null for an unknown id', async () => {
    const snap = await loadHeadlessSnapshot(exportDir)
    expect(headlessBoardView(snap!, 'does-not-exist')).toBeNull()
  })

  it('every list sort mode orders cards identically in both readers', async () => {
    // Throwaway DB + export dir so the shared snapshot the other tests
    // diff against stays untouched. The assertion is parity, not a
    // specific order: data.ts `cardOrdering` and headless `compareCards`
    // must agree for each mode or this fails.
    const { db: db2, close } = openDatabase({
      filePath: ':memory:',
      migrationsFolder: MIGRATIONS
    })
    try {
      seedSampleData(db2)
      const listId = getBoardView(db2)!.lists[0]!.id
      const root = join(tmpRoot, 'sort-parity')
      const exDir = join(root, 'export')
      const modes = [
        'created-desc',
        'created-asc',
        'added-desc',
        'added-asc',
        'due-asc',
        'title-asc',
        'title-desc',
        'priority-desc'
      ] as const
      for (const mode of modes) {
        applyMutation(db2, {
          type: 'list.update',
          id: listId,
          patch: { sortMode: mode }
        })
        await exportToFolder(db2, root, exDir)
        const snap = await loadHeadlessSnapshot(exDir)
        expect(headlessBoardView(snap!), `sort mode ${mode}`).toEqual(
          getBoardView(db2)
        )
      }
    } finally {
      close()
    }
  })

  it('archived cards + closed lists read identically in both readers', async () => {
    // Throwaway DB, same reason as the sort-parity case. Covers the
    // board view hiding archived cards (and keeping closed lists,
    // flagged) plus the board.archived read's two orderings. Several
    // cards are archived back-to-back so some share a millisecond and
    // the id tiebreak is exercised, not just the timestamp sort.
    const { db: db2, close } = openDatabase({
      filePath: ':memory:',
      migrationsFolder: MIGRATIONS
    })
    try {
      seedSampleData(db2)
      const view = getBoardView(db2)!
      const boardId = view.board.id
      const cards = view.lists.flatMap((l) => l.cards)
      expect(cards.length).toBeGreaterThanOrEqual(3)
      for (const c of cards.slice(0, 3)) {
        applyMutation(db2, {
          type: 'card.update',
          id: c.id,
          patch: { archived: true }
        })
      }
      applyMutation(db2, {
        type: 'list.update',
        id: view.lists[view.lists.length - 1]!.id,
        patch: { closed: true }
      })
      const root = join(tmpRoot, 'archive-parity')
      const exDir = join(root, 'export')
      await exportToFolder(db2, root, exDir)
      const snap = await loadHeadlessSnapshot(exDir)

      expect(headlessBoardView(snap!, boardId)).toEqual(
        getBoardView(db2, boardId)
      )
      const live = getArchivedItems(db2, boardId)
      expect(live!.cards).toHaveLength(3)
      expect(live!.lists).toHaveLength(1)
      expect(headlessArchivedItems(snap!, boardId)).toEqual(live)
      expect(headlessArchivedItems(snap!, 'does-not-exist')).toBeNull()
    } finally {
      close()
    }
  })

  it('card density settings read identically in both readers', async () => {
    const { db: db2, sqlite: sqlite2, close } = openDatabase({
      filePath: ':memory:',
      migrationsFolder: MIGRATIONS
    })
    try {
      seedSampleData(db2)
      const view = getBoardView(db2)!
      const boardId = view.board.id
      const [first, second] = view.lists
      const cards = view.lists.flatMap((l) => l.cards)
      applyMutation(db2, {
        type: 'list.update',
        id: first!.id,
        patch: { cardDensity: 'compact', visibleCardLimit: 2 }
      })
      applyMutation(db2, {
        type: 'list.update',
        id: second!.id,
        patch: { visibleCardLimit: 10 }
      })
      applyMutation(db2, {
        type: 'card.update',
        id: cards[0]!.id,
        patch: { collapsed: false }
      })
      applyMutation(db2, {
        type: 'card.update',
        id: cards[1]!.id,
        patch: { collapsed: true }
      })
      // An out-of-range stored limit (hand-edited row) must narrow to
      // "show all" the same way in both readers.
      const third = view.lists[2]
      if (third) {
        sqlite2
          .prepare('UPDATE list SET visible_card_limit = ? WHERE id = ?')
          .run(5000, third.id)
      }
      const root = join(tmpRoot, 'density-parity')
      const exDir = join(root, 'export')
      await exportToFolder(db2, root, exDir)
      const snap = await loadHeadlessSnapshot(exDir)
      expect(headlessBoardView(snap!, boardId)).toEqual(getBoardView(db2, boardId))
      for (const c of cards.slice(0, 2)) {
        expect(headlessCardView(snap!, c.id)).toEqual(getCardView(db2, c.id))
      }
    } finally {
      close()
    }
  })

  it('"waiting on" links read identically in both readers', async () => {
    // Links across two boards, one far end completed and one archived,
    // two links made in the same millisecond (the far-end id breaks the
    // tie in both readers), plus an old-format export with no links key.
    const { db: db2, close } = openDatabase({
      filePath: ':memory:',
      migrationsFolder: MIGRATIONS
    })
    try {
      const mk = (name: string): { boardId: string; listId: string } => {
        const boardId = applyMutation(db2, { type: 'board.create', name }).id
        const listId = applyMutation(db2, {
          type: 'list.create',
          boardId,
          name: `${name} list`
        }).id
        return { boardId, listId }
      }
      const card = (listId: string, title: string): string =>
        applyMutation(db2, { type: 'card.create', listId, title }).id
      const work = mk('Work')
      const home = mk('Home')
      const a = card(work.listId, 'A')
      const b = card(work.listId, 'B')
      const c = card(home.listId, 'C')
      const d = card(home.listId, 'D')
      const link = (id: string, blockerId: string): void => {
        applyMutation(db2, { type: 'card.addBlocker', id, blockerId })
      }
      const realNow = Date.now
      Date.now = () => 1_700_000_000_000
      try {
        link(a, d)
        link(a, c)
      } finally {
        Date.now = realNow
      }
      link(a, b)
      link(b, c)
      applyMutation(db2, { type: 'card.update', id: c, patch: { completed: true } })
      applyMutation(db2, { type: 'card.update', id: b, patch: { archived: true } })

      const root = join(tmpRoot, 'deps-parity')
      const exDir = join(root, 'export')
      await exportToFolder(db2, root, exDir)
      const snap = await loadHeadlessSnapshot(exDir)

      expect(getCardView(db2, a)!.blockedBy.map((r) => r.title)).toEqual(
        c < d ? ['C', 'D', 'B'] : ['D', 'C', 'B']
      )
      for (const id of [a, b, c, d]) {
        expect(headlessCardView(snap!, id)).toEqual(getCardView(db2, id))
      }
      for (const boardId of [work.boardId, home.boardId]) {
        expect(headlessBoardView(snap!, boardId)).toEqual(getBoardView(db2, boardId))
      }

      // An export from before links existed has no cardDependencies key.
      const legacy = {
        ...snap!,
        dump: { ...snap!.dump, cardDependencies: undefined }
      }
      expect(headlessCardView(legacy, a)!.blockedBy).toEqual([])
    } finally {
      close()
    }
  })

  it('agenda reads identically in both readers', async () => {
    // Throwaway DB spanning every section and every exclusion: two
    // boards, due dates on both sides of each window edge, a normal
    // completion and a list on-enter auto-complete (both write the
    // activity rows completedAt comes from), a completed card with no
    // activity row, one completed outside the window, and hidden
    // surface (archived card, closed list, archived board).
    const { db: db2, sqlite, close } = openDatabase({
      filePath: ':memory:',
      migrationsFolder: MIGRATIONS
    })
    try {
      const now = Date.now()
      const day = (n: number): number => localDayStart(now, n)
      const mk = (name: string): { boardId: string; listId: string } => {
        const boardId = applyMutation(db2, { type: 'board.create', name }).id
        const listId = applyMutation(db2, {
          type: 'list.create',
          boardId,
          name: `${name} todo`
        }).id
        return { boardId, listId }
      }
      const card = (
        listId: string,
        title: string,
        patch: Record<string, unknown> = {}
      ): string => {
        const id = applyMutation(db2, { type: 'card.create', listId, title }).id
        if (Object.keys(patch).length > 0) {
          applyMutation(db2, { type: 'card.update', id, patch } as Mutation)
        }
        return id
      }

      const a = mk('Work')
      applyMutation(db2, {
        type: 'board.update',
        id: a.boardId,
        patch: { color: 'oklch(0.7 0.15 250)' }
      })
      const b = mk('Home')
      card(a.listId, 'Overdue urgent', { dueAt: day(-2), priority: 'urgent' })
      card(b.listId, 'Overdue low', { dueAt: day(-2), priority: 'low' })
      card(a.listId, 'Today', { dueAt: day(0) })
      card(b.listId, 'Today high', { dueAt: day(0), priority: 'high' })
      card(a.listId, 'Tomorrow', { dueAt: day(1) })
      card(b.listId, 'Edge of week', { dueAt: day(8) - 1 })
      card(a.listId, 'Beyond week', { dueAt: day(8) })
      card(a.listId, 'Undated')
      card(a.listId, 'Done', { completed: true })
      const noActivity = card(b.listId, 'Done no activity', { completed: true })
      sqlite.prepare('DELETE FROM activity WHERE card_id = ?').run(noActivity)
      const old = card(b.listId, 'Done long ago', { completed: true })
      sqlite
        .prepare('UPDATE activity SET created_at = ? WHERE card_id = ?')
        .run(day(-20), old)

      const done = applyMutation(db2, {
        type: 'list.create',
        boardId: a.boardId,
        name: 'Done'
      }).id
      applyMutation(db2, {
        type: 'list.update',
        id: done,
        patch: { onEnter: { kind: 'complete' } }
      })
      const moved = card(a.listId, 'Auto-completed', { dueAt: day(0) })
      applyMutation(db2, { type: 'card.move', id: moved, toListId: done })

      card(a.listId, 'Archived', { dueAt: day(0), archived: true })
      // One due card waiting on an open card, one on a finished card.
      const waits = card(b.listId, 'Waits (blocked)', { dueAt: day(1) })
      const openBlocker = card(b.listId, 'Open blocker')
      applyMutation(db2, { type: 'card.addBlocker', id: waits, blockerId: openBlocker })
      const closed = mk('Closed list board')
      card(closed.listId, 'In closed list', { dueAt: day(0) })
      applyMutation(db2, {
        type: 'list.update',
        id: closed.listId,
        patch: { closed: true }
      })
      const archived = mk('Archived board')
      card(archived.listId, 'On archived board', { dueAt: day(0) })
      applyMutation(db2, {
        type: 'board.update',
        id: archived.boardId,
        patch: { archived: true }
      })

      const root = join(tmpRoot, 'agenda-parity')
      const exDir = join(root, 'export')
      await exportToFolder(db2, root, exDir)
      const snap = await loadHeadlessSnapshot(exDir)

      const live = getAgenda(db2, { now })
      expect(live.totals).toEqual({
        overdue: 2,
        today: 2,
        upcoming: 3,
        completed: 2
      })
      expect(live.upcoming.find((i) => i.title === 'Waits (blocked)')?.blocked).toBe(true)
      expect(headlessAgenda(snap!, { now })).toEqual(live)

      const narrow = { now, upcomingDays: 1, completedDays: 30, limit: 1 }
      expect(headlessAgenda(snap!, narrow)).toEqual(getAgenda(db2, narrow))
    } finally {
      close()
    }
  })

  it('headlessCardView matches getCardView for every seeded card', async () => {
    const snap = await loadHeadlessSnapshot(exportDir)
    const board = getBoardView(db)!
    for (const list of board.lists) {
      for (const card of list.cards) {
        expect(headlessCardView(snap!, card.id)).toEqual(
          getCardView(db, card.id)
        )
      }
    }
  })

  it('headlessCardView returns null for an unknown id', async () => {
    const snap = await loadHeadlessSnapshot(exportDir)
    expect(headlessCardView(snap!, 'does-not-exist')).toBeNull()
  })

  it('headlessCardView surfaces the stitched description body', async () => {
    const snap = await loadHeadlessSnapshot(exportDir)
    const firstCardId = getBoardView(db)!.lists[0]!.cards[0]!.id
    const v = headlessCardView(snap!, firstCardId)
    expect(v?.description).toMatch(/Heading/)
    // Sanity: the live view should agree (we just wrote it above).
    expect(getCardView(db, firstCardId)?.description).toBe(v?.description)
  })

  it('headlessSearchCards matches searchCards for a title hit', async () => {
    const snap = await loadHeadlessSnapshot(exportDir)
    expect(headlessSearchCards(snap!, 'drag')).toEqual(
      searchCards(db, 'drag')
    )
  })

  it('headlessSearchCards matches searchCards for a label hit', async () => {
    const snap = await loadHeadlessSnapshot(exportDir)
    expect(headlessSearchCards(snap!, 'bug')).toEqual(
      searchCards(db, 'bug')
    )
  })

  it('headlessSearchCards matches searchCards for a description hit', async () => {
    const snap = await loadHeadlessSnapshot(exportDir)
    // The first card now has a description containing "bold markdown".
    expect(headlessSearchCards(snap!, 'bold markdown')).toEqual(
      searchCards(db, 'bold markdown')
    )
  })

  it('headlessSearchCards honours the limit cap', async () => {
    const snap = await loadHeadlessSnapshot(exportDir)
    const live = searchCards(db, 'a', 2)
    const headless = headlessSearchCards(snap!, 'a', 2)
    expect(headless.length).toBeLessThanOrEqual(2)
    expect(headless).toEqual(live)
  })

  it('headlessSearchCards returns [] for an empty / whitespace-only query', async () => {
    const snap = await loadHeadlessSnapshot(exportDir)
    expect(headlessSearchCards(snap!, '')).toEqual([])
    expect(headlessSearchCards(snap!, '   ')).toEqual([])
  })
})

describe('loadHeadlessSnapshot edge cases', () => {
  it('returns null when no export folder exists', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'kanbini-mcp-empty-'))
    try {
      expect(await loadHeadlessSnapshot(empty)).toBeNull()
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })

  it('throws on corrupt JSON', async () => {
    const corrupt = await mkdtemp(join(tmpdir(), 'kanbini-mcp-corrupt-'))
    try {
      await writeFile(join(corrupt, 'kanbini.json'), 'not json at all')
      await expect(loadHeadlessSnapshot(corrupt)).rejects.toThrow(/JSON/)
    } finally {
      await rm(corrupt, { recursive: true, force: true })
    }
  })

  it('throws on an unsupported export format version', async () => {
    const bad = await mkdtemp(join(tmpdir(), 'kanbini-mcp-fv-'))
    try {
      await writeFile(
        join(bad, 'kanbini.json'),
        JSON.stringify({ formatVersion: 99, projects: [] })
      )
      await expect(loadHeadlessSnapshot(bad)).rejects.toThrow(
        /format version 99/
      )
    } finally {
      await rm(bad, { recursive: true, force: true })
    }
  })
})

describe('MCP server falls back to the export when the app is closed', () => {
  let client: Client

  beforeAll(async () => {
    // userDataDir already has the export populated by the outer
    // beforeAll, and crucially has NO `mcp.json` - the MCP server
    // sees no discovery + falls back to the headless snapshot for
    // every read tool.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_PATH],
      env: {
        ...process.env,
        KANBINI_USERDATA_OVERRIDE: userDataDir
      }
    })
    client = new Client({
      name: 'kanbini-mcp-headless-test',
      version: '0.0.0'
    })
    await client.connect(transport)
  }, 30_000)

  afterAll(async () => {
    await client?.close().catch(() => {})
  })

  /** Headless responses are `[NOTE] …\n\n<json>`; split + parse. */
  function parseFallback(text: string): { prefix: string; data: unknown } {
    const sep = '\n\n'
    const idx = text.indexOf(sep)
    if (idx < 0) {
      throw new Error(
        `expected a fallback notice prefix, got: ${text.slice(0, 120)}`
      )
    }
    return {
      prefix: text.slice(0, idx),
      data: JSON.parse(text.slice(idx + sep.length))
    }
  }

  it('kanbini_list_boards returns prefixed data drawn from the export', async () => {
    const res = (await client.callTool({
      name: 'kanbini_list_boards',
      arguments: {}
    })) as { content: Array<{ text: string }>; isError?: boolean }
    expect(res.isError).toBeFalsy()
    const { prefix, data } = parseFallback(res.content[0]!.text)
    expect(prefix).toMatch(/\[NOTE\].*Kanbini desktop app is closed/)
    expect(prefix).toMatch(/last on-disk export/)
    expect(Array.isArray(data)).toBe(true)
    expect((data as unknown[]).length).toBeGreaterThan(0)
  })

  it('kanbini_get_board falls back to a real board view', async () => {
    const res = (await client.callTool({
      name: 'kanbini_get_board',
      arguments: {}
    })) as { content: Array<{ text: string }>; isError?: boolean }
    expect(res.isError).toBeFalsy()
    const { data } = parseFallback(res.content[0]!.text)
    const view = data as { lists: Array<{ cards: unknown[] }> }
    expect(view.lists.length).toBeGreaterThan(0)
    expect(view.lists[0]!.cards.length).toBeGreaterThan(0)
  })

  it('kanbini_search_cards falls back too', async () => {
    const res = (await client.callTool({
      name: 'kanbini_search_cards',
      arguments: { query: 'drag' }
    })) as { content: Array<{ text: string }>; isError?: boolean }
    expect(res.isError).toBeFalsy()
    const { data } = parseFallback(res.content[0]!.text)
    const hits = data as Array<{ title: string }>
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.title.toLowerCase()).toContain('drag')
  })

  it('kanbini_get_agenda falls back too', async () => {
    const res = (await client.callTool({
      name: 'kanbini_get_agenda',
      arguments: {}
    })) as { content: Array<{ text: string }>; isError?: boolean }
    expect(res.isError).toBeFalsy()
    const { prefix, data } = parseFallback(res.content[0]!.text)
    expect(prefix).toMatch(/\[NOTE\]/)
    expect(data).toMatchObject({
      upcomingDays: 7,
      completedDays: 7,
      overdue: expect.any(Array),
      today: expect.any(Array),
      upcoming: expect.any(Array),
      completed: expect.any(Array)
    })
  })

  it('write tools error with a clear "app is not running" message', async () => {
    const res = (await client.callTool({
      name: 'kanbini_create_board',
      arguments: { name: 'should fail offline' }
    })) as { content: Array<{ text: string }>; isError?: boolean }
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toMatch(/is not running/i)
    expect(res.content[0]!.text).toMatch(/writes need the app open/i)
  })
})
