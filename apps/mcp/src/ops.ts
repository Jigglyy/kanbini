import { z } from 'zod'
import {
  ACCENT_NAMES,
  AUTO_CARD_LIMIT,
  AUTO_CARD_LIMIT_ABOVE,
  MAX_VISIBLE_CARD_LIMIT,
  decodeEscapedWhitespace,
  newId,
  resolveAccentColor,
  zListSortMode,
  type Mutation
} from '@kanbini/shared'
import { isBatchRef, looksLikeId, type Resolver } from './refs.js'
import { parseLocalDate } from './summary.js'

// Every write tool as data: its arguments (a zod shape), its description,
// and `build`, which turns the arguments into the app's mutations. Each
// tool runs its own op; kanbini_batch runs any number of them as one
// change (one transaction, one Ctrl+Z). A step in a batch takes the same
// arguments as the tool of the same name, so learning one teaches both.
//
// `build` mints the ids of whatever it creates (the app takes a
// caller-chosen id on every create), which is what lets a later step in
// the same batch use them: `ref: "x"` on a create step, `"$x"` after.

export interface Built {
  mutations: Mutation[]
  /** Which mutation's result the tool reports ({ id, boardId }). */
  primary: number
}

export interface OpSpec {
  /** Tool name without the `kanbini_` prefix; also the batch `op`. */
  name: string
  title: string
  description: string
  shape: z.ZodRawShape
  /** Makes something a later batch step can point at with `ref`. */
  creates?: boolean
  build(args: Record<string, unknown>, r: Resolver, ref?: string): Promise<Built>
}

function op<S extends z.ZodRawShape>(spec: {
  name: string
  title: string
  description: string
  shape: S
  creates?: boolean
  build(args: z.infer<z.ZodObject<S>>, r: Resolver, ref?: string): Promise<Built>
}): OpSpec {
  return spec as unknown as OpSpec
}

const one = (m: Mutation): Built => ({ mutations: [m], primary: 0 })

// ─── shared argument pieces ──────────────────────────────────────

const zBoardRef = z
  .string()
  .optional()
  .describe(
    "The board's id or exact name. Needed when you name a card by number (#142) or a list / label by name."
  )
const zColorInput = z
  .string()
  .min(1)
  .max(32)
  .describe(
    `One of the app palette names (${ACCENT_NAMES.join(', ')}) - preferred, so the colour ` +
      'matches the swatches in the app - or a raw CSS colour string such as one read back ' +
      'from another entity.'
  )
const zPriority = z.enum(['low', 'medium', 'high', 'urgent'])
const zRepeat = z.object({
  unit: z.enum(['day', 'week', 'month', 'year']),
  every: z.number().int().min(1).max(99)
})
const zDate = z.string().describe('Local calendar day, YYYY-MM-DD')

export const CARD_REF_HINT =
  'A card can be given by its id, or by its number (`#142`, as shown on the card) with ' +
  '`boardId` (the id or name of the board it is on).'
const LIST_REF_HINT =
  'A list can be given by its id, or by its exact name with `boardId`.'
const LABEL_REF_HINT = 'Labels can be given by id or by name.'
export const PALETTE_HINT =
  `Colours: pass a palette name (${ACCENT_NAMES.join(', ')}) so it matches the app's swatch picker.`

const color = (c: string) => resolveAccentColor(c)

/** `due` (YYYY-MM-DD) or `dueAt` (epoch ms), whichever was given. */
function dueOf(args: { due?: string | null; dueAt?: number | null }): number | null | undefined {
  if (args.due !== undefined && args.dueAt !== undefined) {
    throw new Error('Pass `due` or `dueAt`, not both.')
  }
  if (args.due !== undefined) return args.due === null ? null : parseLocalDate(args.due)
  return args.dueAt
}

const defined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>

// ─── boards ──────────────────────────────────────────────────────

const createBoard = op({
  name: 'create_board',
  title: 'Create a board',
  description:
    'Create a new empty board (no lists, no cards). `name` is the required board title; ' +
    '`description` is an optional short blurb shown on the home picker. Returns { id, boardId } ' +
    "- both equal the new board's id. Add columns next with kanbini_create_list, then cards with " +
    'kanbini_create_card (or all of it in one kanbini_batch).',
  creates: true,
  shape: { name: z.string().min(1), description: z.string().optional() },
  async build({ name, description }, r, ref) {
    const id = newId()
    r.defineRef(ref, id)
    r.noteBoard(id)
    return one({ type: 'board.create', id, name, ...defined({ description }) })
  }
})

const updateBoard = op({
  name: 'update_board',
  title: 'Update board settings',
  description:
    'Patch a board. `name` renames it; `description` is the short blurb on the home picker ' +
    '(null clears it); `color` is the board accent shown on its home card and header tint (null ' +
    'clears it); `pinned` favourites it to the top of the home picker. Omit fields you do not ' +
    'want to change. `id` is the board id or its exact name. To archive a board use ' +
    'kanbini_archive_board. ' +
    PALETTE_HINT,
  shape: {
    id: z.string(),
    patch: z.object({
      name: z.string().min(1).optional(),
      description: z.string().nullable().optional(),
      color: zColorInput.nullable().optional(),
      pinned: z.boolean().optional()
    })
  },
  async build({ id, patch }, r) {
    return one({
      type: 'board.update',
      id: (await r.board(id))!,
      patch: {
        ...patch,
        ...(typeof patch.color === 'string' ? { color: color(patch.color) } : {})
      }
    })
  }
})

const archiveBoard = op({
  name: 'archive_board',
  title: 'Archive or restore a board',
  description:
    'Archive (archived: true) or restore (archived: false) a board. An archived board is hidden ' +
    'from the home picker (the user can still reach it with "Show archived") and its cards drop ' +
    'out of search. Nothing is deleted. kanbini_list_boards still returns archived boards, ' +
    'flagged `archived: true`. `id` is the board id or its exact name.',
  shape: { id: z.string(), archived: z.boolean() },
  async build({ id, archived }, r) {
    return one({ type: 'board.update', id: (await r.board(id))!, patch: { archived } })
  }
})

const deleteBoard = op({
  name: 'delete_board',
  title: 'Delete a board',
  description:
    'Permanently delete a board with all of its lists, cards and labels. Prefer ' +
    'kanbini_archive_board unless the user clearly asks for it to be deleted; confirm the board ' +
    'by name first. The user can undo it in the app (Ctrl+Z from the boards home). `id` is the ' +
    'board id or its exact name.',
  shape: { id: z.string() },
  async build({ id }, r) {
    return one({ type: 'board.delete', id: (await r.board(id))! })
  }
})

// ─── lists ───────────────────────────────────────────────────────

const createList = op({
  name: 'create_list',
  title: 'Create a list (column)',
  description:
    'Create a new list (column) at the right end of a board. `boardId` is the board id or its ' +
    'exact name. Returns { id, boardId }; cards can then name the list by its id or name.',
  creates: true,
  shape: { boardId: z.string(), name: z.string().min(1) },
  async build({ boardId, name }, r, ref) {
    const board = (await r.board(boardId))!
    const id = newId()
    r.defineRef(ref, id)
    r.noteList(board, name, id)
    return one({ type: 'list.create', id, boardId: board, name })
  }
})

const updateList = op({
  name: 'update_list',
  title: 'Update list settings',
  description:
    'Patch a list (column). `name` renames it. `color` tints the list header and border (null ' +
    'clears it). `wipLimit` sets a work-in-progress cap - a positive integer, or null to remove ' +
    'it; the app shows the count against the cap and blocks drags past it, but the limit is NOT ' +
    'enforced for writes, so check the card count yourself before adding. `sortMode` orders the ' +
    'cards: "manual" (drag order, the default), "created-asc"/"created-desc" (card creation ' +
    'time), "added-asc"/"added-desc" (when the card entered this list), "due-asc" (soonest due ' +
    'first, undated last), "title-asc"/"title-desc" (alphabetical), "priority-desc" (urgent ' +
    'first). Switching back to "manual" freezes the current sorted order as the new drag order. ' +
    '`onEnter` runs when a card is moved INTO this list from another one: "complete" marks it ' +
    'done, "uncomplete" reopens it, null removes the rule. `cardDensity` "compact" draws every ' +
    'card in the list compact (a card can opt out with kanbini_update_card collapsed: false); ' +
    '"full" is the default. `visibleCardLimit` shows at most that many cards on screen, then a ' +
    '"Show N more" button (1-1000); 0 always shows every card; null (the default) lets the app ' +
    `shorten a list of more than ${AUTO_CARD_LIMIT_ABOVE} cards to its first ${AUTO_CARD_LIMIT} ` +
    '(the user can turn that off). Both are display only: the reads always return EVERY card, ' +
    'so never read a limit as the list being shorter. Change them only when the user asks. To ' +
    'reorder lists use kanbini_move_list; to hide one use kanbini_archive_list. ' +
    LIST_REF_HINT +
    ' ' +
    PALETTE_HINT,
  shape: {
    id: z.string(),
    boardId: zBoardRef,
    patch: z.object({
      name: z.string().min(1).optional(),
      color: zColorInput.nullable().optional(),
      wipLimit: z.number().int().positive().nullable().optional(),
      sortMode: z.enum(['manual', ...zListSortMode.options]).optional(),
      onEnter: z.enum(['complete', 'uncomplete']).nullable().optional(),
      cardDensity: z.enum(['full', 'compact']).optional(),
      visibleCardLimit: z.number().int().min(0).max(MAX_VISIBLE_CARD_LIMIT).nullable().optional()
    })
  },
  async build({ id, boardId, patch }, r) {
    const { color: c, sortMode, onEnter, cardDensity, ...rest } = patch
    return one({
      type: 'list.update',
      id: await r.list(id, boardId),
      patch: {
        ...rest,
        ...(c !== undefined ? { color: c === null ? null : color(c) } : {}),
        ...(sortMode !== undefined ? { sortMode: sortMode === 'manual' ? null : sortMode } : {}),
        ...(onEnter !== undefined ? { onEnter: onEnter === null ? null : { kind: onEnter } } : {}),
        // "full" is the stored null; spelled out for the AI so it never
        // has to know the column's null convention.
        ...(cardDensity !== undefined
          ? { cardDensity: cardDensity === 'full' ? null : cardDensity }
          : {})
      }
    })
  }
})

const moveList = op({
  name: 'move_list',
  title: 'Reorder a list',
  description:
    "Move a list (column) to a new position on its board. Named from the moved list's point of " +
    'view: `beforeId` is the list that will sit directly to its LEFT, `afterId` the list directly ' +
    'to its RIGHT. So to put list X just right of list Y, pass `beforeId: Y`. One neighbour is ' +
    'enough, the server works out the other. Omit both for the far right; pass only `afterId` = ' +
    'the first list for the far left. Neighbours must be lists on the same board (closed lists ' +
    'count too, since they keep their slot). ' +
    LIST_REF_HINT,
  shape: {
    id: z.string(),
    boardId: zBoardRef,
    beforeId: z.string().nullable().optional().describe('List that will sit directly LEFT of the moved list'),
    afterId: z.string().nullable().optional().describe('List that will sit directly RIGHT of the moved list')
  },
  async build({ id, boardId, beforeId, afterId }, r) {
    return one({
      type: 'list.move',
      id: await r.list(id, boardId),
      beforeId: beforeId ? await r.list(beforeId, boardId) : null,
      afterId: afterId ? await r.list(afterId, boardId) : null
    })
  }
})

const archiveList = op({
  name: 'archive_list',
  title: 'Archive or restore a list',
  description:
    'Archive (archived: true) or restore (archived: false) a whole list (column). An archived ' +
    'list is hidden from the board along with every card in it, and its cards drop out of search ' +
    'and counts; nothing is deleted, and restoring brings the list back in its original slot ' +
    "with its cards. Tell the user: they can see and restore it in the app from the board's " +
    'pencil menu > Archived..., and kanbini_list_archived finds it too. ' +
    LIST_REF_HINT,
  shape: { id: z.string(), boardId: zBoardRef, archived: z.boolean() },
  async build({ id, boardId, archived }, r) {
    return one({ type: 'list.update', id: await r.list(id, boardId), patch: { closed: archived } })
  }
})

const deleteList = op({
  name: 'delete_list',
  title: 'Delete a list',
  description:
    'Permanently delete a list (column) and every card in it. Prefer kanbini_archive_list unless ' +
    'the user asks for it to be deleted, and say how many cards go with it before you do. The ' +
    'user can undo it in the app (Ctrl+Z on that board). ' +
    LIST_REF_HINT,
  shape: { id: z.string(), boardId: zBoardRef },
  async build({ id, boardId }, r) {
    return one({ type: 'list.delete', id: await r.list(id, boardId) })
  }
})

// ─── cards ───────────────────────────────────────────────────────

const zChecklistsInput = z
  .array(
    z.object({
      name: z.string().min(1),
      items: z.array(z.string().min(1)).max(200).optional()
    })
  )
  .max(20)

/** checklist.create + one checklistItem.create per item. */
function checklistMutations(cardId: string, name: string, items: string[] = []): Mutation[] {
  const checklistId = newId()
  return [
    { type: 'checklist.create', id: checklistId, cardId, name },
    ...items.map((text): Mutation => ({ type: 'checklistItem.create', id: newId(), checklistId, text }))
  ]
}

const createCard = op({
  name: 'create_card',
  title: 'Create a card',
  description:
    'Create a card, complete in ONE call: `title` plus any of `description` (Markdown, with real ' +
    'line breaks), `due` (YYYY-MM-DD) or `dueAt` (epoch ms at local midnight), `priority` ' +
    "('low' | 'medium' | 'high' | 'urgent'), `labels` (names or ids of labels on that board; " +
    'make a missing one with kanbini_create_label), `checklists` ([{ name, items: [text, ...] }]), ' +
    '`repeat`, and `completed`. It goes at the end of the list unless you give `beforeId` (the card ' +
    'that will sit directly ABOVE it) or `afterId` (the card directly BELOW). Returns { id, ' +
    "boardId }. Respect a list's `wipLimit`: it is advisory and not enforced, so check the " +
    'card count before adding when one is set. ' +
    LIST_REF_HINT +
    ' Labels by name and cards by number need `boardId` too.',
  creates: true,
  shape: {
    listId: z.string(),
    boardId: zBoardRef,
    title: z.string().min(1),
    description: z.string().optional(),
    due: zDate.optional(),
    dueAt: z.number().int().optional(),
    priority: zPriority.optional(),
    labels: z.array(z.string()).optional(),
    checklists: zChecklistsInput.optional(),
    repeat: zRepeat.optional(),
    completed: z.boolean().optional(),
    beforeId: z.string().nullable().optional().describe('Card that will sit directly ABOVE the new card'),
    afterId: z.string().nullable().optional().describe('Card that will sit directly BELOW the new card')
  },
  async build(a, r, ref) {
    const listId = await r.list(a.listId, a.boardId)
    const id = newId()
    r.defineRef(ref, id)
    const mutations: Mutation[] = [
      { type: 'card.create', id, listId, title: a.title, ...(a.priority ? { priority: a.priority } : {}) }
    ]
    const dueAt = dueOf(a)
    const patch = defined({
      description: a.description !== undefined ? decodeEscapedWhitespace(a.description) : undefined,
      dueAt: dueAt ?? undefined,
      repeat: a.repeat,
      completed: a.completed
    })
    if (Object.keys(patch).length > 0) mutations.push({ type: 'card.update', id, patch })
    const labelIds = a.labels ? await Promise.all(a.labels.map((l) => r.label(l, a.boardId))) : []
    r.noteCardLabels(id, labelIds)
    if (labelIds.length > 0) mutations.push({ type: 'card.setLabels', id, labelIds })
    for (const cl of a.checklists ?? []) mutations.push(...checklistMutations(id, cl.name, cl.items))
    if (a.beforeId || a.afterId) {
      mutations.push({
        type: 'card.move',
        id,
        toListId: listId,
        beforeId: a.beforeId ? await r.card(a.beforeId, a.boardId) : null,
        afterId: a.afterId ? await r.card(a.afterId, a.boardId) : null
      })
    }
    return { mutations, primary: 0 }
  }
})

const updateCard = op({
  name: 'update_card',
  title: 'Update card fields',
  description:
    'Patch one or more card fields. `title` and `description` are strings; `description` accepts ' +
    'Markdown - use real line breaks for paragraphs and lists (a literal backslash-n renders as ' +
    'text, not a break). `due` is a YYYY-MM-DD day (or `dueAt`, epoch ms), null clears it. ' +
    '`completed` toggles the checkbox. `coverAttachmentId` is the attachment id to use as the ' +
    "cover banner, or null to clear. `priority` is one of 'low' | 'medium' | 'high' | 'urgent', " +
    'or null to clear. `collapsed` only changes how the card is DRAWN in its list: true shows it ' +
    "compact, false keeps it full even in a compact list, null follows the list's `cardDensity`. " +
    'It hides nothing from you, so change it only when the user asks for a tidier board. `repeat` ' +
    "makes the card repeat: { unit: 'day' | 'week' | 'month' | 'year', every: 1-99 } (e.g. " +
    "{ unit: 'week', every: 2 } for every two weeks), or null to stop. When a repeating card is " +
    'completed, the app adds the next one to the list it was worked in, due one repeat after the ' +
    'old due date (always in the future), with the same title, description, labels, priority, ' +
    'and unticked checklists; the rule moves to the new card. Omit fields you do not want to ' +
    'change. Labels: kanbini_set_card_labels. ' +
    CARD_REF_HINT,
  shape: {
    id: z.string(),
    boardId: zBoardRef,
    patch: z.object({
      title: z.string().min(1).optional(),
      description: z.string().nullable().optional(),
      due: zDate.nullable().optional(),
      dueAt: z.number().int().nullable().optional(),
      completed: z.boolean().optional(),
      coverAttachmentId: z.string().nullable().optional(),
      priority: zPriority.nullable().optional(),
      collapsed: z.boolean().nullable().optional(),
      repeat: zRepeat.nullable().optional()
    })
  },
  async build({ id, boardId, patch }, r) {
    const { due, dueAt: _dueAt, ...rest } = patch
    const dueAt = dueOf(patch)
    return one({
      type: 'card.update',
      id: await r.card(id, boardId),
      patch: {
        ...rest,
        ...(dueAt !== undefined ? { dueAt } : {}),
        // Decode a description sent with literal "\n" escapes instead of
        // real line breaks (see decodeEscapedWhitespace).
        ...(typeof rest.description === 'string'
          ? { description: decodeEscapedWhitespace(rest.description) }
          : {})
      }
    })
  }
})

const zToBoard = z
  .string()
  .optional()
  .describe("Board of `toListId` when you name that list and it is on another board (id or name)")

const moveCard = op({
  name: 'move_card',
  title: 'Move or reorder a card',
  description:
    'Move a card between lists, or reorder within its current list. `toListId` is the destination ' +
    "list. The position is optional and named from the moved card's point of view: `beforeId` is " +
    'the card that will sit directly ABOVE it, `afterId` the card directly BELOW it. So to put ' +
    'card X right under card Y, pass `beforeId: Y` (not `afterId`). One neighbour is enough, the ' +
    'server works out the other. Omit both to add the card to the END of the list; pass only ' +
    '`afterId` = the first card to put it at the top. To place several cards in order, move the ' +
    'first one, then each next one with `beforeId` = the card you just moved (in one kanbini_batch). ' +
    "Respect the destination list's `wipLimit` when one is set (advisory, not enforced). Lists " +
    'with a sortMode order themselves, so a move into one lands wherever the sort puts it. Card ' +
    "numbers are per board: a move to another board gives the card that board's next number, and " +
    "its labels follow by name (the other board's label with the same name, or a new one there " +
    'in the same colour). ' +
    CARD_REF_HINT +
    ' The list can be named too: on `boardId`, or on `toBoardId` for another board.',
  shape: {
    id: z.string(),
    boardId: zBoardRef,
    toListId: z.string(),
    toBoardId: zToBoard,
    beforeId: z.string().nullable().optional().describe('Card that will sit directly ABOVE the moved card'),
    afterId: z.string().nullable().optional().describe('Card that will sit directly BELOW the moved card')
  },
  async build({ id, boardId, toListId, toBoardId, beforeId, afterId }, r) {
    const target = toBoardId ?? boardId
    return one({
      type: 'card.move',
      id: await r.card(id, boardId),
      toListId: await r.list(toListId, target),
      beforeId: beforeId ? await r.card(beforeId, target) : null,
      afterId: afterId ? await r.card(afterId, target) : null
    })
  }
})

const copyCard = op({
  name: 'copy_card',
  title: 'Copy a card',
  description:
    'Make a copy of a card in any list, on this board or another one. The copy gets the title ' +
    '(or `title`), description, due date, priority, repeat rule, completion, labels (on another ' +
    'board: the label with the same name there, or a new one in the same colour), checklists ' +
    'with their ticks, and attachments. Comments, activity and "waiting on" links stay with the ' +
    'original. Position works like kanbini_move_card: `beforeId` is the card that will sit ' +
    'directly ABOVE the copy, `afterId` the one directly BELOW; omit both for the end of the ' +
    'list. So to put the copy right under the original, pass the original as `beforeId`. Returns ' +
    '{ id, boardId } of the copy, which gets its own card number. ' +
    CARD_REF_HINT +
    ' The list can be named too: on `boardId`, or on `toBoardId` for another board.',
  creates: true,
  shape: {
    id: z.string(),
    boardId: zBoardRef,
    toListId: z.string(),
    toBoardId: zToBoard,
    title: z.string().min(1).optional(),
    beforeId: z.string().nullable().optional().describe('Card that will sit directly ABOVE the copy'),
    afterId: z.string().nullable().optional().describe('Card that will sit directly BELOW the copy')
  },
  async build({ id, boardId, toListId, toBoardId, title, beforeId, afterId }, r, ref) {
    const target = toBoardId ?? boardId
    const newCardId = newId()
    r.defineRef(ref, newCardId)
    return one({
      type: 'card.copy',
      id: await r.card(id, boardId),
      newId: newCardId,
      toListId: await r.list(toListId, target),
      ...(title !== undefined ? { title } : {}),
      beforeId: beforeId ? await r.card(beforeId, target) : null,
      afterId: afterId ? await r.card(afterId, target) : null
    })
  }
})

const archiveCard = op({
  name: 'archive_card',
  title: 'Archive or restore a card',
  description:
    'Archive (archived: true) or restore (archived: false) a card. An archived card disappears ' +
    'from the board, search, and card counts but keeps its list, position, checklists, comments, ' +
    'and attachments, so restoring puts it back exactly where it was. Tell the user the card was ' +
    "archived rather than deleted: they can see and restore it in the app from the board's " +
    'pencil menu > Archived..., and kanbini_list_archived finds it too. Prefer this over ' +
    'kanbini_delete_card when the user wants a card "out of the way". ' +
    CARD_REF_HINT,
  shape: { id: z.string(), boardId: zBoardRef, archived: z.boolean() },
  async build({ id, boardId, archived }, r) {
    return one({ type: 'card.update', id: await r.card(id, boardId), patch: { archived } })
  }
})

const deleteCard = op({
  name: 'delete_card',
  title: 'Delete a card',
  description:
    'Permanently delete a card. Its checklists, comments, and attachment rows are removed by the ' +
    'FK cascade. Files attached to the card stay on disk until the GC sweep - they cannot be ' +
    'restored from the UI, so confirm intent before calling. ' +
    CARD_REF_HINT,
  shape: { id: z.string(), boardId: zBoardRef },
  async build({ id, boardId }, r) {
    return one({ type: 'card.delete', id: await r.card(id, boardId) })
  }
})

const setCardLabels = op({
  name: 'set_card_labels',
  title: 'Set, add or remove card labels',
  description:
    "Change a card's labels. `labelIds` are label ids or names (labels must belong to the " +
    "card's board; make a missing one with kanbini_create_label). `mode` \"replace\" (the " +
    'default) sets exactly these labels (an empty array removes all), "add" adds them to the ' +
    'ones it has, "remove" takes them off. ' +
    CARD_REF_HINT,
  shape: {
    id: z.string(),
    boardId: zBoardRef,
    labelIds: z.array(z.string()),
    mode: z.enum(['replace', 'add', 'remove']).optional()
  },
  async build({ id, boardId, labelIds, mode }, r) {
    const cardId = await r.card(id, boardId)
    const needsBoard = labelIds.some((l) => !looksLikeId(l) && !isBatchRef(l))
    const board = boardId ?? (needsBoard ? await r.boardOfCard(cardId) : undefined)
    const ids = await Promise.all(labelIds.map((l) => r.label(l, board)))
    let next = ids
    if (mode === 'add' || mode === 'remove') {
      const current = await r.cardLabels(cardId)
      next =
        mode === 'add'
          ? [...current, ...ids.filter((x) => !current.includes(x))]
          : current.filter((x) => !ids.includes(x))
    }
    r.noteCardLabels(cardId, next)
    return one({ type: 'card.setLabels', id: cardId, labelIds: next })
  }
})

const blockerShape = { cardId: z.string(), blockerId: z.string(), boardId: zBoardRef }

const addBlocker = op({
  name: 'add_blocker',
  title: 'Mark a card as waiting on another',
  description:
    'Record that card `cardId` waits on card `blockerId` (a "blocked by" link). The card shows ' +
    'as blocked in the app until the blocker is completed or archived. The two cards may be on ' +
    'different boards. Adding a link that already exists does nothing. Rejected when both are ' +
    'the same card, or when `blockerId` already waits on `cardId` directly or through other ' +
    "cards (that would make a loop). A card's links are in the `blockedBy` and `blocking` " +
    'arrays of kanbini_get_card. The user can undo in the app. ' +
    CARD_REF_HINT +
    ' Two numbers must both be on that board; for a blocker on another board, use its id.',
  shape: blockerShape,
  async build({ cardId, blockerId, boardId }, r) {
    return one({
      type: 'card.addBlocker',
      id: await r.card(cardId, boardId),
      blockerId: await r.card(blockerId, boardId)
    })
  }
})

const removeBlocker = op({
  name: 'remove_blocker',
  title: 'Stop a card waiting on another',
  description:
    'Remove the link that makes card `cardId` wait on card `blockerId`. Removing a link that ' +
    "doesn't exist does nothing. Neither card changes otherwise. " +
    CARD_REF_HINT,
  shape: blockerShape,
  async build({ cardId, blockerId, boardId }, r) {
    return one({
      type: 'card.removeBlocker',
      id: await r.card(cardId, boardId),
      blockerId: await r.card(blockerId, boardId)
    })
  }
})

// ─── comments ────────────────────────────────────────────────────

const postComment = op({
  name: 'post_comment',
  title: 'Post a comment as the AI',
  description:
    "Post a comment on a card. Author is automatically set to 'ai' so it renders with the AI " +
    'badge in the UI (and is distinguishable from human-written comments). Body is Markdown - put ' +
    'real line breaks between paragraphs and list items. A literal backslash-n renders as the ' +
    'text "\\n", not a line break. ' +
    CARD_REF_HINT,
  creates: true,
  shape: { cardId: z.string(), boardId: zBoardRef, body: z.string().min(1) },
  async build({ cardId, boardId, body }, r, ref) {
    const id = newId()
    r.defineRef(ref, id)
    return one({
      type: 'comment.create',
      id,
      cardId: await r.card(cardId, boardId),
      // Recover line breaks if the client sent literal "\n" escapes.
      body: decodeEscapedWhitespace(body),
      author: 'ai'
    })
  }
})

const updateComment = op({
  name: 'update_comment',
  title: 'Edit a comment',
  description:
    'Replace the text of a comment (ids are in the `comments` of kanbini_get_card). Markdown, with ' +
    'real line breaks. Comments the user wrote (author null) are theirs: change one only when ' +
    'they ask. The user can undo in the app.',
  shape: { id: z.string(), body: z.string().min(1) },
  async build({ id, body }, r) {
    return one({ type: 'comment.update', id: r.id(id), patch: { body: decodeEscapedWhitespace(body) } })
  }
})

const deleteComment = op({
  name: 'delete_comment',
  title: 'Delete a comment',
  description:
    'Delete a comment from a card. Comments the user wrote (author null) are theirs: delete one ' +
    'only when they ask. The user can undo in the app.',
  shape: { id: z.string() },
  async build({ id }, r) {
    return one({ type: 'comment.delete', id: r.id(id) })
  }
})

// ─── checklists ──────────────────────────────────────────────────

const createChecklist = op({
  name: 'create_checklist',
  title: 'Add a checklist to a card',
  description:
    'Create a checklist on a card, with its `items` (texts, in order) in the same call. Returns ' +
    '{ id, boardId }; add more later with kanbini_add_checklist_item. ' +
    CARD_REF_HINT,
  creates: true,
  shape: {
    cardId: z.string(),
    boardId: zBoardRef,
    name: z.string().min(1),
    items: z.array(z.string().min(1)).max(200).optional()
  },
  async build({ cardId, boardId, name, items }, r, ref) {
    const mutations = checklistMutations(await r.card(cardId, boardId), name, items)
    r.defineRef(ref, (mutations[0] as { id: string }).id)
    return { mutations, primary: 0 }
  }
})

const renameChecklist = op({
  name: 'rename_checklist',
  title: 'Rename a checklist',
  description: "Rename a card's checklist (ids are in the `checklists` of kanbini_get_card).",
  shape: { id: z.string(), name: z.string().min(1) },
  async build({ id, name }, r) {
    return one({ type: 'checklist.update', id: r.id(id), patch: { name } })
  }
})

const deleteChecklist = op({
  name: 'delete_checklist',
  title: 'Delete a checklist',
  description: 'Delete a whole checklist with all of its items. The user can undo in the app.',
  shape: { id: z.string() },
  async build({ id }, r) {
    return one({ type: 'checklist.delete', id: r.id(id) })
  }
})

const addChecklistItem = op({
  name: 'add_checklist_item',
  title: 'Add a checklist item',
  description: 'Append an item to an existing checklist. Returns { id, boardId }.',
  creates: true,
  shape: { checklistId: z.string(), text: z.string().min(1) },
  async build({ checklistId, text }, r, ref) {
    const id = newId()
    r.defineRef(ref, id)
    return one({ type: 'checklistItem.create', id, checklistId: r.id(checklistId), text })
  }
})

const toggleChecklistItem = op({
  name: 'toggle_checklist_item',
  title: 'Check or uncheck a checklist item',
  description: 'Set the completed flag on a checklist item. Pass true to mark it done, false to reopen.',
  shape: { id: z.string(), completed: z.boolean() },
  async build({ id, completed }, r) {
    return one({ type: 'checklistItem.update', id: r.id(id), patch: { completed } })
  }
})

const updateChecklistItem = op({
  name: 'update_checklist_item',
  title: 'Edit a checklist item',
  description:
    "Change a checklist item's `text`, and/or tick it (`completed`). Omit what you do not want to change.",
  shape: { id: z.string(), text: z.string().min(1).optional(), completed: z.boolean().optional() },
  async build({ id, text, completed }, r) {
    if (text === undefined && completed === undefined) {
      throw new Error('Pass `text`, `completed`, or both.')
    }
    return one({ type: 'checklistItem.update', id: r.id(id), patch: defined({ text, completed }) })
  }
})

const moveChecklistItem = op({
  name: 'move_checklist_item',
  title: 'Reorder or move a checklist item',
  description:
    'Move a checklist item within its checklist or to another checklist (`toChecklistId`, which ' +
    'may be on another card). `beforeId` is the item that will sit directly ABOVE it, `afterId` ' +
    'the one directly BELOW; one is enough, and omitting both puts it at the end.',
  shape: {
    id: z.string(),
    toChecklistId: z.string(),
    beforeId: z.string().nullable().optional().describe('Item that will sit directly ABOVE the moved item'),
    afterId: z.string().nullable().optional().describe('Item that will sit directly BELOW the moved item')
  },
  async build({ id, toChecklistId, beforeId, afterId }, r) {
    return one({
      type: 'checklistItem.move',
      id: r.id(id),
      toChecklistId: r.id(toChecklistId),
      beforeId: beforeId ? r.id(beforeId) : null,
      afterId: afterId ? r.id(afterId) : null
    })
  }
})

const deleteChecklistItem = op({
  name: 'delete_checklist_item',
  title: 'Delete a checklist item',
  description: 'Remove one item from a checklist. The user can undo in the app.',
  shape: { id: z.string() },
  async build({ id }, r) {
    return one({ type: 'checklistItem.delete', id: r.id(id) })
  }
})

// ─── labels ──────────────────────────────────────────────────────

const createLabel = op({
  name: 'create_label',
  title: 'Create a label',
  description:
    'Create a new label on a board (`boardId`: id or name). Labels are board-scoped: put it on ' +
    "that board's cards by name or id. Check the board's `labels` first so you reuse an " +
    'existing label instead of making a near-duplicate. Returns { id, boardId }. ' +
    PALETTE_HINT,
  creates: true,
  shape: { boardId: z.string(), name: z.string().min(1), color: zColorInput },
  async build({ boardId, name, color: c }, r, ref) {
    const board = (await r.board(boardId))!
    const id = newId()
    r.defineRef(ref, id)
    r.noteLabel(board, name, id)
    return one({ type: 'label.create', id, boardId: board, name, color: color(c) })
  }
})

const updateLabel = op({
  name: 'update_label',
  title: 'Rename or recolour a label',
  description:
    'Patch a label. `name` renames it and `color` recolours it - the change shows on every card ' +
    'carrying the label. Omit fields you do not want to change. ' +
    LABEL_REF_HINT +
    ' (by name with `boardId`). ' +
    PALETTE_HINT,
  shape: {
    id: z.string(),
    boardId: zBoardRef,
    patch: z.object({ name: z.string().min(1).optional(), color: zColorInput.optional() })
  },
  async build({ id, boardId, patch }, r) {
    return one({
      type: 'label.update',
      id: await r.label(id, boardId),
      patch: { ...patch, ...(patch.color !== undefined ? { color: color(patch.color) } : {}) }
    })
  }
})

const deleteLabel = op({
  name: 'delete_label',
  title: 'Delete a label',
  description:
    'Delete a label from its board. It is removed from EVERY card that carries it. The user can ' +
    'undo this in the app (Ctrl+Z), which puts it back on the same cards, but confirm intent ' +
    'first when the label is in use. ' +
    LABEL_REF_HINT +
    ' (by name with `boardId`).',
  shape: { id: z.string(), boardId: zBoardRef },
  async build({ id, boardId }, r) {
    return one({ type: 'label.delete', id: await r.label(id, boardId) })
  }
})

/** In tool-list order. Attachments aren't here: they move files, so they
 *  have their own tools and can't ride a batch. */
export const OPS: OpSpec[] = [
  createBoard,
  createList,
  createCard,
  updateCard,
  moveCard,
  copyCard,
  deleteCard,
  setCardLabels,
  addBlocker,
  removeBlocker,
  postComment,
  updateComment,
  deleteComment,
  createChecklist,
  renameChecklist,
  deleteChecklist,
  addChecklistItem,
  toggleChecklistItem,
  updateChecklistItem,
  moveChecklistItem,
  deleteChecklistItem,
  updateBoard,
  updateList,
  moveList,
  createLabel,
  updateLabel,
  deleteLabel,
  archiveCard,
  archiveList,
  archiveBoard,
  deleteList,
  deleteBoard
]

export const OPS_BY_NAME = new Map(OPS.map((o) => [o.name, o]))
