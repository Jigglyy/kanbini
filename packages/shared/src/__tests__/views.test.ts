import { describe, expect, it } from 'vitest'
import {
  zAppInfo,
  zAttachmentView,
  zBoardSummary,
  zBoardView,
  zCardView,
  zChecklistItemView,
  zChecklistView,
  zCommentView,
  zExportSummary,
  zImportSummary,
  zLabelView,
  zListView,
  zMcpInfo,
  zSearchCardsRequest,
  zSearchHit
} from '../views'

// View schemas are the IPC contract main ↔ renderer (+ MCP) all parse
// against. The renderer trusts the parsed shape directly, so round-
// trip + a few "must reject" guards lock down what we will + won't
// accept across the wire.

describe('leaf view schemas', () => {
  it('round-trips a LabelView', () => {
    const v = { id: 'l1', name: 'bug', color: '#ff0000' }
    expect(zLabelView.parse(v)).toEqual(v)
  })

  it('round-trips an AttachmentView (with + without url provenance)', () => {
    const local = {
      id: 'a1',
      filename: 'shot.png',
      relPath: 'attachments/a1/shot.png',
      mime: 'image/png',
      size: 1234,
      sourceUrl: null,
      sourceTitle: null,
      createdAt: 1700000000000
    }
    const url = {
      ...local,
      id: 'a2',
      sourceUrl: 'https://example.com/post',
      sourceTitle: 'Example Post'
    }
    expect(zAttachmentView.parse(local)).toEqual(local)
    expect(zAttachmentView.parse(url)).toEqual(url)
  })

  it('round-trips a CommentView (human + ai)', () => {
    const human = {
      id: 'cm1',
      body: 'hi',
      author: null,
      createdAt: 1,
      updatedAt: 1
    }
    const ai = { ...human, id: 'cm2', author: 'ai' }
    expect(zCommentView.parse(human).author).toBeNull()
    expect(zCommentView.parse(ai).author).toBe('ai')
  })

  it('round-trips a ChecklistView with items', () => {
    const v = {
      id: 'cl1',
      name: 'sub',
      position: 'a0',
      items: [
        { id: 'ci1', text: 'a', completed: false, position: 'a0' },
        { id: 'ci2', text: 'b', completed: true, position: 'a1' }
      ]
    }
    expect(zChecklistView.parse(v)).toEqual(v)
    expect(
      zChecklistItemView.parse({
        id: 'ci3',
        text: 'c',
        completed: false,
        position: 'a2'
      })
    ).toBeDefined()
  })
})

describe('zCardView / zListView / zBoardView', () => {
  const card = {
    id: 'c1',
    title: 'A card',
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
    activities: []
  }

  it('round-trips a minimal CardView', () => {
    expect(zCardView.parse(card)).toEqual(card)
  })

  it('round-trips a minimal ListView with one card', () => {
    const list = {
      id: 'l1',
      name: 'Todo',
      color: null,
      closed: false,
      position: 'a0',
      wipLimit: null,
      sortMode: null,
      onEnter: null,
      cards: [card]
    }
    expect(zListView.parse(list)).toEqual(list)
  })

  it('round-trips a BoardView', () => {
    const view = {
      project: { id: 'p1', name: 'P' },
      board: {
        id: 'b1',
        name: 'B',
        color: null,
        background: null,
        swimlaneMode: null
      },
      labels: [],
      lists: []
    }
    expect(zBoardView.parse(view)).toEqual(view)
  })

  it('round-trips a BoardView with each background kind (ADR-0034)', () => {
    const base = {
      project: { id: 'p1', name: 'P' },
      labels: [],
      lists: []
    }
    const color = {
      ...base,
      board: {
        id: 'b1',
        name: 'B',
        color: null,
        background: { kind: 'color' as const, value: 'oklch(0.7 0.1 250)' },
        swimlaneMode: null
      }
    }
    const gradient = {
      ...base,
      board: {
        id: 'b1',
        name: 'B',
        color: null,
        background: { kind: 'gradient' as const, preset: 'sunset' },
        swimlaneMode: null
      }
    }
    const image = {
      ...base,
      board: {
        id: 'b1',
        name: 'B',
        color: null,
        background: {
          kind: 'image' as const,
          relPath: 'board-backgrounds/b1/wallpaper.jpg'
        },
        swimlaneMode: null
      }
    }
    expect(zBoardView.parse(color)).toEqual(color)
    expect(zBoardView.parse(gradient)).toEqual(gradient)
    expect(zBoardView.parse(image)).toEqual(image)
  })

  it('rejects an unknown background kind', () => {
    expect(() =>
      zBoardView.parse({
        project: { id: 'p1', name: 'P' },
        board: {
          id: 'b1',
          name: 'B',
          color: null,
          background: { kind: 'video', src: 'x' }
        },
        labels: [],
        lists: []
      })
    ).toThrow()
  })
})

describe('zBoardSummary (home picker)', () => {
  it('round-trips a typical row', () => {
    const row = {
      id: 'b1',
      projectId: 'p1',
      name: 'B',
      description: 'desc',
      color: null,
      background: null,
      archived: false,
      pinned: true,
      position: 'a0',
      listCount: 3,
      cardCount: 12,
      createdAt: 1,
      updatedAt: 2
    }
    expect(zBoardSummary.parse(row)).toEqual(row)
  })

  it('rejects a negative card count', () => {
    expect(() =>
      zBoardSummary.parse({
        id: 'b1',
        projectId: 'p1',
        name: 'B',
        description: null,
        color: null,
        background: null,
        archived: false,
        pinned: false,
        position: 'a0',
        listCount: 0,
        cardCount: -1,
        createdAt: 1,
        updatedAt: 1
      })
    ).toThrow()
  })
})

describe('zSearchCardsRequest / zSearchHit', () => {
  it('accepts empty query (renderer short-circuits but main is lenient)', () => {
    expect(zSearchCardsRequest.parse({ query: '' })).toEqual({ query: '' })
  })

  it('rejects limit > 100 (hard cap to keep search bounded)', () => {
    expect(() =>
      zSearchCardsRequest.parse({ query: 'x', limit: 1000 })
    ).toThrow()
  })

  it('rejects limit ≤ 0', () => {
    expect(() =>
      zSearchCardsRequest.parse({ query: 'x', limit: 0 })
    ).toThrow()
  })

  it('round-trips a hit with each matchKind', () => {
    const base = {
      cardId: 'c1',
      title: 'T',
      descriptionSnippet: null,
      boardId: 'b1',
      boardName: 'B',
      listName: 'L',
      matchedLabels: [],
      updatedAt: 1
    }
    for (const matchKind of ['title', 'label', 'description'] as const) {
      expect(zSearchHit.parse({ ...base, matchKind }).matchKind).toBe(matchKind)
    }
  })

  it('rejects unknown matchKind', () => {
    expect(() =>
      zSearchHit.parse({
        cardId: 'c1',
        title: 'T',
        descriptionSnippet: null,
        boardId: 'b1',
        boardName: 'B',
        listName: 'L',
        matchedLabels: [],
        matchKind: 'cover',
        updatedAt: 1
      })
    ).toThrow()
  })
})

describe('zExportSummary / zImportSummary (M4-A/B)', () => {
  const counts = {
    projects: 1,
    boards: 1,
    lists: 1,
    cards: 1,
    labels: 0,
    cardLabels: 0,
    checklists: 0,
    checklistItems: 0,
    comments: 0,
    attachments: 0,
    activities: 0
  }

  it('round-trips an export summary', () => {
    const v = {
      exportedAt: 1,
      destRoot: '/tmp/export',
      formatVersion: 1,
      counts
    }
    expect(zExportSummary.parse(v)).toEqual(v)
  })

  it('round-trips an import summary (extra counters)', () => {
    const v = {
      importedAt: 1,
      sourceRoot: '/tmp/in',
      formatVersion: 1,
      counts: { ...counts, descriptionsFromMd: 1, attachmentFilesCopied: 0 }
    }
    expect(zImportSummary.parse(v)).toEqual(v)
  })
})

describe('zAppInfo / zMcpInfo (M4-F)', () => {
  it('round-trips an AppInfo', () => {
    const v = {
      version: '0.0.0',
      versions: { electron: '41.0.0', chrome: '135', node: '22' },
      paths: {
        userData: '/u',
        db: '/u/kanbini.sqlite',
        attachments: '/u/attachments',
        export: '/u/export',
        notices: '/u/NOTICES.md'
      },
      platform: 'win32'
    }
    expect(zAppInfo.parse(v)).toEqual(v)
  })

  it('round-trips a McpInfo (running + not running)', () => {
    const running = {
      channel: { running: true, port: 12345, token: 'abc' },
      paths: {
        mcpJson: '/u/mcp.json',
        mcpToken: '/u/mcp-token',
        bundle: '/repo/apps/mcp/dist/index.js'
      },
      snippets: { mcpClientJson: '{}' }
    }
    const stopped = {
      channel: { running: false, port: null, token: null },
      paths: { mcpJson: '/u/mcp.json', mcpToken: '/u/mcp-token', bundle: null },
      snippets: { mcpClientJson: '{}' }
    }
    expect(zMcpInfo.parse(running)).toEqual(running)
    expect(zMcpInfo.parse(stopped)).toEqual(stopped)
  })
})
