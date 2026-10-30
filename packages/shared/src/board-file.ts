import { z } from 'zod'

// One board in one file (`<name>.kanbini`), for moving a board to another
// Kanbini or sending it to someone. The file is a zip: `board.json` (the
// zBoardFile shape below) plus the files it points at, stored under the
// relPaths they have in userData (`attachments/<id>/<name>`,
// `board-backgrounds/<boardId>/<name>`). Importing makes a NEW board with
// fresh ids (@kanbini/db board-file.ts), so the same file can come in
// twice and never touches what's already there.
//
// Two contents:
//   'lists' - the board's set-up: its look, labels, and open lists with
//             their settings. No cards.
//   'cards' - everything on the board: cards with descriptions, labels,
//             checklists, comments, attachments, links, history; closed
//             lists and archived cards come along and stay archived.
//
// The file is untrusted input. Values the app soft-narrows when it reads
// its own database (priority, sort mode, rules, background ...) are loose
// here and narrowed on import the same way, so a file from a newer build
// with a value this one doesn't know still comes in.

export const BOARD_FILE_EXTENSION = 'kanbini'
export const BOARD_FILE_FORMAT = 'kanbini-board'
/** Bumped on a change an older build can't read. The importer refuses a
 *  newer version with a clear message instead of half-reading it. */
export const BOARD_FILE_VERSION = 1 as const
/** The JSON entry inside the zip. */
export const BOARD_FILE_JSON = 'board.json'

export const zBoardFileContent = z.enum(['lists', 'cards'])
export type BoardFileContent = z.infer<typeof zBoardFileContent>

const zId = z.string().min(1)
const zTime = z.number()

const zFileBoard = z.object({
  name: z.string().min(1),
  description: z.string().nullable(),
  color: z.string().nullable(),
  background: z.unknown().nullable(),
  swimlaneMode: z.string().nullable(),
  /** The board's card number counter (0 for 'lists'). */
  cardNumberLast: z.number().int().nonnegative()
})

const zFileLabel = z.object({
  id: zId,
  name: z.string(),
  color: z.string(),
  createdAt: zTime,
  updatedAt: zTime
})

const zFileList = z.object({
  id: zId,
  name: z.string().min(1),
  color: z.string().nullable(),
  position: z.string(),
  closed: z.boolean(),
  wipLimit: z.number().nullable(),
  sortMode: z.string().nullable(),
  onEnter: z.unknown().nullable(),
  cardDensity: z.string().nullable(),
  visibleCardLimit: z.number().nullable(),
  createdAt: zTime,
  updatedAt: zTime
})

const zFileCard = z.object({
  id: zId,
  listId: zId,
  number: z.number().nullable(),
  title: z.string().min(1),
  description: z.string().nullable(),
  position: z.string(),
  dueAt: z.number().nullable(),
  completed: z.boolean(),
  archived: z.boolean(),
  coverAttachmentId: z.string().nullable(),
  priority: z.string().nullable(),
  listAddedAt: zTime,
  collapsed: z.boolean().nullable(),
  repeat: z.unknown().nullable(),
  createdAt: zTime,
  updatedAt: zTime
})

const zFileChecklist = z.object({
  id: zId,
  cardId: zId,
  name: z.string().min(1),
  position: z.string(),
  createdAt: zTime,
  updatedAt: zTime
})

const zFileChecklistItem = z.object({
  id: zId,
  checklistId: zId,
  text: z.string().min(1),
  completed: z.boolean(),
  position: z.string(),
  createdAt: zTime,
  updatedAt: zTime
})

const zFileComment = z.object({
  id: zId,
  cardId: zId,
  body: z.string(),
  author: z.string().nullable(),
  createdAt: zTime,
  updatedAt: zTime
})

const zFileAttachment = z.object({
  id: zId,
  cardId: zId,
  filename: z.string().min(1),
  /** Where the file is inside the zip (and was in the exporter's
   *  userData). Copies of a card share one file, so two rows can name
   *  the same relPath. */
  relPath: z.string().min(1),
  mime: z.string().nullable(),
  size: z.number().nullable(),
  sourceUrl: z.string().nullable(),
  sourceTitle: z.string().nullable(),
  createdAt: zTime
})

const zFileActivity = z.object({
  id: zId,
  cardId: z.string().nullable(),
  type: z.string().min(1),
  data: z.unknown(),
  createdAt: zTime
})

/** Just enough to tell a board file (and its version) from anything else,
 *  checked before the full parse so a newer file gets a clear message. */
export const zBoardFileHeader = z.object({
  format: z.literal(BOARD_FILE_FORMAT),
  version: z.number().int()
})

export const zBoardFile = zBoardFileHeader.extend({
  exportedAt: zTime,
  content: zBoardFileContent,
  board: zFileBoard,
  labels: z.array(zFileLabel),
  lists: z.array(zFileList),
  cards: z.array(zFileCard),
  cardLabels: z.array(z.object({ cardId: zId, labelId: zId })),
  /** Only links with both cards on this board. */
  cardDependencies: z.array(z.object({ cardId: zId, blockerId: zId, createdAt: zTime })),
  checklists: z.array(zFileChecklist),
  checklistItems: z.array(zFileChecklistItem),
  comments: z.array(zFileComment),
  attachments: z.array(zFileAttachment),
  activities: z.array(zFileActivity)
})
export type BoardFile = z.infer<typeof zBoardFile>

/** `board:export` - pick where to save, then write the file. */
export const zBoardExportRequest = z.object({
  boardId: z.string(),
  content: zBoardFileContent
})
export type BoardExportRequest = z.infer<typeof zBoardExportRequest>

/** `board:export` result; null when the save dialog was cancelled. */
export const zBoardExportResult = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  /** Attachments whose file was missing on disk, left out of the file. */
  skippedAttachments: z.number().int().nonnegative()
})
export type BoardExportResult = z.infer<typeof zBoardExportResult>

/** `board:import` result; null when the file picker was cancelled. */
export const zBoardImportSummary = z.object({
  boardId: z.string(),
  boardName: z.string(),
  content: zBoardFileContent,
  counts: z.object({
    lists: z.number().int().nonnegative(),
    labels: z.number().int().nonnegative(),
    cards: z.number().int().nonnegative(),
    attachments: z.number().int().nonnegative()
  }),
  /** Attachments named in board.json whose file wasn't in the zip. */
  skippedAttachments: z.number().int().nonnegative()
})
export type BoardImportSummary = z.infer<typeof zBoardImportSummary>

/** `shell:showInFolder` - reveal a file this app just wrote. */
export const zShowInFolderRequest = z.object({ path: z.string() })
export type ShowInFolderRequest = z.infer<typeof zShowInFolderRequest>
