import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_CODENAME, type Mutation } from '@kanbini/shared'
import {
  applyMutationRecorded,
  exportToFolder,
  getBoardView,
  getCardView,
  listBoards,
  openDatabase,
  searchCards,
  seedSampleData,
  type Db
} from '@kanbini/db'
import {
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
