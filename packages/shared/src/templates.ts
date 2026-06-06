import { z } from 'zod'
import {
  zBoardBackground,
  zCardPriority,
  zListSortMode,
  zSwimlaneMode
} from './views'

// Board / list templates (ADR-0038). One row in `template` per saved
// template; `kind` discriminates board vs list, `data` carries the
// versioned snapshot. v1 captures structure + cards (titles +
// descriptions + priority + checklists + label assignments - for board
// templates only). Time-bound data is intentionally excluded:
//   - comments / activity / attachments / dueAt - these are events on a
//     particular card at a particular time, not template structure.
// All ids in the payload are template-internal - fresh UUIDv7s are
// minted at instantiate time so the new entities have no overlap with
// the source they were saved from.

/** Discriminates the two template flavours. */
export const zTemplateKind = z.enum(['board', 'list'])
export type TemplateKind = z.infer<typeof zTemplateKind>

/** Bumped on any breaking change to the snapshot shape. The reader
 *  rejects mismatches up-front - better than partial-decoding into a
 *  half-broken state. */
export const TEMPLATE_FORMAT_VERSION = 1 as const

const zTplChecklistItem = z.object({
  text: z.string().min(1).max(500),
  completed: z.boolean(),
  position: z.string()
})

const zTplChecklist = z.object({
  name: z.string().min(1).max(200),
  position: z.string(),
  items: z.array(zTplChecklistItem)
})

/** Card-shaped slice of a template. `labelTmplIds` are board-template
 *  internal - they point at entries in the template's own `labels`
 *  list and get remapped to fresh label ids at instantiate time.
 *  List templates omit labels (labels are board-scoped). */
const zTplCard = z.object({
  title: z.string().min(1).max(500),
  description: z.string().nullable(),
  position: z.string(),
  priority: zCardPriority.nullable(),
  completed: z.boolean(),
  /** Empty for list templates. Indexes into the board template's
   *  own `labels` array (template-internal ids). */
  labelTmplIds: z.array(z.string()),
  checklists: z.array(zTplChecklist)
})

const zTplList = z.object({
  name: z.string().min(1).max(200),
  color: z.string().nullable(),
  position: z.string(),
  wipLimit: z.number().int().positive().nullable(),
  sortMode: zListSortMode.nullable(),
  cards: z.array(zTplCard)
})

const zTplLabel = z.object({
  /** Template-internal id (NOT a real label.id). Cards reference these
   *  via `labelTmplIds`; instantiate mints fresh real ids and remaps. */
  tmplId: z.string(),
  name: z.string().min(1).max(200),
  color: z.string()
})

/** Board-template payload (v1). */
export const zTemplateBoardData = z.object({
  version: z.literal(TEMPLATE_FORMAT_VERSION),
  board: z.object({
    name: z.string().min(1).max(200),
    description: z.string().nullable(),
    color: z.string().nullable(),
    background: zBoardBackground.nullable(),
    swimlaneMode: zSwimlaneMode.nullable()
  }),
  labels: z.array(zTplLabel),
  lists: z.array(zTplList)
})
export type TemplateBoardData = z.infer<typeof zTemplateBoardData>

/** List-template payload (v1). Carries one list + its cards. Labels
 *  are board-scoped, so a list template doesn't capture them - when
 *  pasted into a target board, its cards arrive label-less. */
export const zTemplateListData = z.object({
  version: z.literal(TEMPLATE_FORMAT_VERSION),
  list: z.object({
    name: z.string().min(1).max(200),
    color: z.string().nullable(),
    wipLimit: z.number().int().positive().nullable(),
    sortMode: zListSortMode.nullable()
  }),
  cards: z.array(
    // List-template cards omit labelTmplIds (labels are board-scoped
    // and the list doesn't know which board it'll land in).
    zTplCard.omit({ labelTmplIds: true })
  )
})
export type TemplateListData = z.infer<typeof zTemplateListData>

/** Lightweight summary row for the Templates manager + picker UIs.
 *  Counts let the picker render "3 lists · 12 cards" without pulling
 *  the full payload. Computed read-side from the parsed `data`. */
export const zTemplateSummary = z.object({
  id: z.string(),
  kind: zTemplateKind,
  name: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  listCount: z.number().int().nonnegative(),
  cardCount: z.number().int().nonnegative()
})
export type TemplateSummary = z.infer<typeof zTemplateSummary>

export const zTemplateSummaryList = z.array(zTemplateSummary)
export type TemplateSummaryList = z.infer<typeof zTemplateSummaryList>

/** `template:save` request - capture a source entity (board or list)
 *  as a template under the chosen name. */
export const zTemplateSaveRequest = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('board'),
    sourceId: z.string(),
    name: z.string().min(1).max(200)
  }),
  z.object({
    kind: z.literal('list'),
    sourceId: z.string(),
    name: z.string().min(1).max(200)
  })
])
export type TemplateSaveRequest = z.infer<typeof zTemplateSaveRequest>

/** `template:rename`. */
export const zTemplateRenameRequest = z.object({
  id: z.string(),
  name: z.string().min(1).max(200)
})
export type TemplateRenameRequest = z.infer<typeof zTemplateRenameRequest>

/** `template:delete`. */
export const zTemplateDeleteRequest = z.object({ id: z.string() })
export type TemplateDeleteRequest = z.infer<typeof zTemplateDeleteRequest>

/** `template:instantiate` - turn a stored template into real entities.
 *  Board templates ignore `targetBoardId`; list templates require it. */
export const zTemplateInstantiateRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('board'), templateId: z.string() }),
  z.object({
    kind: z.literal('list'),
    templateId: z.string(),
    targetBoardId: z.string()
  })
])
export type TemplateInstantiateRequest = z.infer<
  typeof zTemplateInstantiateRequest
>

/** `template:instantiate` result - the new top-level entity. For board
 *  templates the new `boardId` IS the new top-level id; for list
 *  templates the new `listId` is the appended list. */
export const zTemplateInstantiateResult = z.object({
  kind: zTemplateKind,
  boardId: z.string(),
  listId: z.string().nullable()
})
export type TemplateInstantiateResult = z.infer<
  typeof zTemplateInstantiateResult
>
