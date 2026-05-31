import { z } from 'zod'

// Trello board-export JSON - the file you get from a Trello board's
// "Show menu → More → Print and Export → Export as JSON". We validate
// only the slice we actually map into Kanbini; zod drops every other
// key (non-strict objects). This is the trust boundary: main parses an
// untrusted file with `zTrelloBoard` before handing a typed object to
// `importFromTrello` in @kanbini/db.

const zTrelloLabel = z.object({
  id: z.string(),
  name: z.string().default(''),
  // Trello colour name (e.g. "blue", "sky", "red_dark"); mapped to a
  // Kanbini palette swatch in the importer. May be null (no colour).
  color: z.string().nullable().default(null)
})

const zTrelloList = z.object({
  id: z.string(),
  name: z.string().default(''),
  // Float ordering key - we sort by it, then mint fresh fractional keys.
  pos: z.number().default(0)
})

const zTrelloCheckItem = z.object({
  id: z.string(),
  name: z.string().default(''),
  // "complete" | "incomplete"
  state: z.string().default('incomplete'),
  pos: z.number().default(0)
})

const zTrelloChecklist = z.object({
  id: z.string(),
  idCard: z.string(),
  name: z.string().default(''),
  pos: z.number().default(0),
  checkItems: z.array(zTrelloCheckItem).default([])
})

const zTrelloCard = z.object({
  id: z.string(),
  name: z.string().default(''),
  // Trello card descriptions are already Markdown - copied straight in.
  desc: z.string().default(''),
  idList: z.string(),
  idLabels: z.array(z.string()).default([]),
  // ISO-8601 string or null.
  due: z.string().nullable().default(null),
  dueComplete: z.boolean().default(false),
  pos: z.number().default(0),
  // We don't import attachment files (they're remote trello.com URLs -
  // fetching them would breach offline-by-default, ADR-0023). We keep
  // the array only to count what was skipped for the import summary.
  attachments: z.array(z.unknown()).default([])
})

export const zTrelloBoard = z.object({
  id: z.string(),
  name: z.string().min(1),
  desc: z.string().default(''),
  lists: z.array(zTrelloList).default([]),
  cards: z.array(zTrelloCard).default([]),
  labels: z.array(zTrelloLabel).default([]),
  checklists: z.array(zTrelloChecklist).default([])
})
export type TrelloBoard = z.infer<typeof zTrelloBoard>

/** Returned by the `import:trello` IPC after a successful import.
 *  null (not this shape) = the user cancelled the file picker. */
export const zTrelloImportSummary = z.object({
  boardId: z.string(),
  boardName: z.string(),
  counts: z.object({
    lists: z.number(),
    cards: z.number(),
    labels: z.number(),
    cardLabels: z.number(),
    checklists: z.number(),
    checklistItems: z.number()
  }),
  skipped: z.object({
    /** Trello attachment files - remote URLs, not fetched (ADR-0023). */
    attachments: z.number(),
    /** Cards whose `idList` references no imported list (orphaned -
     *  e.g. the list was deleted in Trello). Dropped rather than landed
     *  on no list; counted here so the loss isn't invisible. */
    cards: z.number(),
    /** Checklists attached to a dropped card - dropped with it. */
    checklists: z.number()
  })
})
export type TrelloImportSummary = z.infer<typeof zTrelloImportSummary>
