import { z } from 'zod'
import {
  zBoardBackground,
  zCardDensity,
  zCardPriority,
  zCardRepeat,
  zListOnEnterRule,
  zListSortMode,
  zSwimlaneMode,
  zVisibleCardLimit
} from './views'

// All writes go through one `mutate` IPC channel as a discriminated
// union (DESIGN §5 single-writer). Main validates with these schemas,
// applies via @kanbini/db, then broadcasts a change event. Renderer
// uses optimistic updates + event-driven invalidation (ADR-0013).

const zColor = z.string().max(32)

export const zMutation = z.discriminatedUnion('type', [
  // project
  z.object({
    type: z.literal('project.create'),
    name: z.string().min(1),
    description: z.string().optional(),
    color: zColor.optional()
  }),
  z.object({
    type: z.literal('project.update'),
    id: z.string(),
    patch: z.object({
      name: z.string().min(1).optional(),
      description: z.string().nullable().optional(),
      color: zColor.nullable().optional(),
      archived: z.boolean().optional()
    })
  }),
  z.object({ type: z.literal('project.delete'), id: z.string() }),

  // board. `projectId` is optional because the UI hides projects
  // (M4-G / ADR-0021): when omitted, the service resolves the lone
  // existing project or creates a default one.
  // `id` is optional and meant for the undo recorder (ADR-0036) -
  // when the recorder replays a forward to redo, it passes the
  // originally-minted id so downstream entries that reference it
  // (e.g. `card.create` with this board's id as its listId-parent)
  // still resolve. The renderer + MCP omit it on first create.
  z.object({
    type: z.literal('board.create'),
    id: z.string().optional(),
    projectId: z.string().optional(),
    name: z.string().min(1),
    description: z.string().optional()
  }),
  z.object({
    type: z.literal('board.update'),
    id: z.string(),
    patch: z.object({
      name: z.string().min(1).optional(),
      description: z.string().nullable().optional(),
      color: zColor.nullable().optional(),
      archived: z.boolean().optional(),
      pinned: z.boolean().optional(),
      // ADR-0034 rich background. null clears it (back to neutral /
      // `color`-only). Image backgrounds are NOT applied through this
      // patch - the file upload goes through `board:setBackgroundImage`
      // IPC which writes the file then issues this mutation with the
      // resolved relPath. Renderers can still set color / gradient
      // backgrounds directly.
      background: zBoardBackground.nullable().optional(),
      // ADR-0037 slice 2 swimlane mode. null = off (flat row of
      // lists, today's default); 'priority' = group cards into
      // horizontal lanes by `card.priority`.
      swimlaneMode: zSwimlaneMode.nullable().optional()
    })
  }),
  z.object({ type: z.literal('board.delete'), id: z.string() }),
  // Reorder a board in the home picker (M4-G+). Same fractional-index
  // pattern as card.move: server mints the position between the two
  // neighbours. Both neighbours MUST live in the same project (the
  // renderer's hidden-projects UI guarantees this); cross-project
  // moves aren't supported by this mutation.
  z.object({
    type: z.literal('board.move'),
    id: z.string(),
    beforeId: z.string().nullable().optional(),
    afterId: z.string().nullable().optional()
  }),
  // Fork the board's layout (M4-G+): copies lists + labels with new
  // ids; no cards. Pinned status does NOT carry over. New board is
  // named "<original> (copy)" and is appended to the end of the
  // project's boards (same position path as board.create).
  //
  // `id` is the SOURCE board. `newId` is the optional id to assign the
  // created duplicate - set by the undo recorder (ADR-0036) so a redo
  // recreates the SAME board id (otherwise redo mints a fresh id and the
  // stored inverse `board.delete <firstDupId>` dangles, leaking a copy).
  z.object({
    type: z.literal('board.duplicate'),
    id: z.string(),
    newId: z.string().optional()
  }),

  // list. `id` optional for the undo recorder (ADR-0036).
  z.object({
    type: z.literal('list.create'),
    id: z.string().optional(),
    boardId: z.string(),
    name: z.string().min(1),
    color: zColor.optional()
  }),
  z.object({
    type: z.literal('list.update'),
    id: z.string(),
    patch: z.object({
      name: z.string().min(1).optional(),
      color: zColor.nullable().optional(),
      closed: z.boolean().optional(),
      wipLimit: z.number().int().positive().nullable().optional(),
      // ADR-0032 per-list sort override; null = back to manual. The
      // service snapshots the displayed order to fresh fractional
      // positions when this flips non-null → null, atomic with the
      // column update. Full mode set lives in zListSortMode (created /
      // added / due / title / priority).
      sortMode: zListSortMode.nullable().optional(),
      // ADR-0041 on-card-enter automation. null = clear the rule.
      // The DB layer fires the matching rule INSIDE the `card.move`
      // transaction so move + rule effect land atomically and log
      // as one event.
      onEnter: zListOnEnterRule.nullable().optional(),
      // View settings (excluded from undo, like board.swimlaneMode):
      // compact cards for the whole list, and how many cards to show
      // before "Show N more". null clears each back to the default.
      cardDensity: zCardDensity.nullable().optional(),
      visibleCardLimit: zVisibleCardLimit.nullable().optional()
    })
  }),
  z.object({ type: z.literal('list.delete'), id: z.string() }),
  // Reorder a list within its board. Same fractional-index pattern as
  // board.move / card.move: the server reads the two neighbour
  // positions and mints a key between them. Both neighbours MUST be
  // siblings on the same board (the renderer reorders the visible
  // lists, which guarantees this); cross-board moves aren't supported.
  z.object({
    type: z.literal('list.move'),
    id: z.string(),
    beforeId: z.string().nullable().optional(),
    afterId: z.string().nullable().optional()
  }),

  // card. `id` optional for the undo recorder (ADR-0036).
  // `priority` optional - ADR-0037 slice 2 swimlane mode lets the
  // renderer create a card directly into a non-null lane (e.g. add
  // a card to the "High" lane → priority='high' from minute zero).
  // Omitted = null = unprioritised, today's default.
  z.object({
    type: z.literal('card.create'),
    id: z.string().optional(),
    // Internal (undo only): the card number to reuse. Omitted on a normal
    // create (the DB hands out the next one); the undo recorder fills it
    // in alongside `id` so a redo brings the card back as the same #N.
    // The external entry points refuse it (see isInternalMutation).
    number: z.number().int().positive().optional(),
    listId: z.string(),
    title: z.string().min(1),
    priority: zCardPriority.nullable().optional()
  }),
  z.object({
    type: z.literal('card.update'),
    id: z.string(),
    patch: z.object({
      title: z.string().min(1).optional(),
      description: z.string().nullable().optional(),
      dueAt: z.number().int().nullable().optional(),
      completed: z.boolean().optional(),
      coverAttachmentId: z.string().nullable().optional(),
      // ADR-0037 card priority. null = unprioritised; the four-level
      // enum matches the renderer badge + the swimlanes lane keys.
      priority: zCardPriority.nullable().optional(),
      // Archive flag. The column shipped in schema v1 and every read
      // path that counts or searches already honours it, but nothing
      // could SET it until the MCP archive tool. An archived card is
      // hidden from the board view, search, and the home counts; it
      // keeps its list, position, and everything attached, so
      // unarchiving puts it back exactly where it was.
      archived: z.boolean().optional(),
      // Per-card collapse (view setting, excluded from undo): true =
      // compact, false = always full, null = follow the list.
      collapsed: z.boolean().nullable().optional(),
      // Repeat rule (null = stop repeating). Completing a repeating card
      // spawns the next one; see card.spawnNext below.
      repeat: zCardRepeat.nullable().optional()
    })
  }),
  z.object({ type: z.literal('card.delete'), id: z.string() }),
  z.object({
    type: z.literal('card.setLabels'),
    id: z.string(),
    labelIds: z.array(z.string())
  }),
  // "Blocked by" links: card `id` waits on card `blockerId`. Adding an
  // existing link or removing a missing one is a no-op. Self-links and
  // links that would close a cycle are rejected.
  z.object({
    type: z.literal('card.addBlocker'),
    id: z.string(),
    blockerId: z.string()
  }),
  z.object({
    type: z.literal('card.removeBlocker'),
    id: z.string(),
    blockerId: z.string()
  }),

  // label (board-scoped). `id` optional for the undo recorder.
  z.object({
    type: z.literal('label.create'),
    id: z.string().optional(),
    boardId: z.string(),
    name: z.string().min(1),
    color: zColor
  }),
  z.object({
    type: z.literal('label.update'),
    id: z.string(),
    patch: z.object({
      name: z.string().min(1).optional(),
      color: zColor.optional()
    })
  }),
  z.object({ type: z.literal('label.delete'), id: z.string() }),

  // checklist (card-scoped). `id` optional for the undo recorder.
  z.object({
    type: z.literal('checklist.create'),
    id: z.string().optional(),
    cardId: z.string(),
    name: z.string().min(1)
  }),
  z.object({
    type: z.literal('checklist.update'),
    id: z.string(),
    patch: z.object({ name: z.string().min(1).optional() })
  }),
  z.object({ type: z.literal('checklist.delete'), id: z.string() }),

  // checklist item (checklist-scoped). `id` optional for the undo recorder.
  z.object({
    type: z.literal('checklistItem.create'),
    id: z.string().optional(),
    checklistId: z.string(),
    text: z.string().min(1)
  }),
  z.object({
    type: z.literal('checklistItem.update'),
    id: z.string(),
    patch: z.object({
      text: z.string().min(1).optional(),
      completed: z.boolean().optional()
    })
  }),
  z.object({ type: z.literal('checklistItem.delete'), id: z.string() }),
  z.object({
    type: z.literal('checklistItem.move'),
    id: z.string(),
    toChecklistId: z.string(),
    beforeId: z.string().nullable().optional(),
    afterId: z.string().nullable().optional()
  }),

  // comment (card-scoped). `author` is `null` for human comments and
  // `'ai'` for MCP-posted ones (M3). Renderer always omits author.
  // `id` optional for the undo recorder.
  z.object({
    type: z.literal('comment.create'),
    id: z.string().optional(),
    cardId: z.string(),
    body: z.string().min(1),
    author: z.string().nullable().optional()
  }),
  z.object({
    type: z.literal('comment.update'),
    id: z.string(),
    patch: z.object({ body: z.string().min(1).optional() })
  }),
  z.object({ type: z.literal('comment.delete'), id: z.string() }),

  // attachment (card-scoped). Adding is its own IPC channel
  // (`attachment:add`) because it involves a native file dialog + file
  // copy; delete fits as a normal mutation. crud.ts also clears the
  // card's coverAttachmentId if it pointed to the deleted attachment.
  z.object({ type: z.literal('attachment.delete'), id: z.string() }),
  // Reorder/move: main computes the fractional key from neighbours
  // (ordering stays server-authoritative). beforeId = the card that ends
  // up above, afterId = below; a missing side is filled in from the
  // list's order, and neither = the end of the list (crud.ts slotKey).
  z.object({
    type: z.literal('card.move'),
    id: z.string(),
    toListId: z.string(),
    beforeId: z.string().nullable().optional(),
    afterId: z.string().nullable().optional(),
    // Internal (undo only): the card's prior "added to list" time. A
    // normal cross-list move omits it and stamps now(); the undo of a
    // move passes the captured value so an undone move restores the
    // original list-entry time instead of re-stamping it to now.
    listAddedAt: z.number().int().optional(),
    // Internal (undo only): the card number to take when the move
    // changes the card's board; ignored otherwise. A normal move to
    // another board omits it and takes that board's next number; the
    // undo recorder fills both directions in so undo / redo bring each
    // number back. The external entry points refuse it.
    number: z.number().int().positive().optional(),
    // Internal (undo only): the labels the card ends up with when the
    // move changes its board. A normal move to another board omits it and
    // the card's labels are matched by name on the target board (missing
    // ones are created there); the undo of such a move passes the card's
    // original label ids so they come back. The external entry points
    // refuse it.
    labelIds: z.array(z.string()).optional()
  }),
  // Copy a card ("Duplicate" in the card menu, or "Copy to..." onto
  // any list of any board). The copy gets the card's title (or `title`),
  // description, due date, priority, repeat rule, completion, labels
  // (matched by name on another board, missing ones created there),
  // checklists with their ticks, and attachments (the copy's rows share
  // the original files). Comments, activity and "waiting on" links stay
  // with the original. beforeId / afterId place it like card.move.
  //
  // `id` is the SOURCE card. `newId` is the id to give the copy - the
  // undo recorder fills it in (like board.duplicate) so a redo recreates
  // the same card.
  z.object({
    type: z.literal('card.copy'),
    id: z.string(),
    toListId: z.string(),
    beforeId: z.string().nullable().optional(),
    afterId: z.string().nullable().optional(),
    title: z.string().min(1).optional(),
    newId: z.string().optional(),
    // Internal (undo only): the copy's card number, like card.create's.
    number: z.number().int().positive().optional()
  }),

  // INTERNAL (never from the renderer or MCP; see isInternalMutation).
  // The undo recorder issues `card.spawnNext` right after a mutation
  // completes a repeating card, in the same undo group: it creates the
  // next occurrence as `copyId` in `toListId` and moves the repeat rule
  // onto it. `card.unspawnNext` is its undo: delete the copy and put the
  // rule back on the original. A redo replays spawnNext with the same
  // copyId, so the recreated card keeps its id.
  z.object({
    type: z.literal('card.spawnNext'),
    id: z.string(),
    copyId: z.string(),
    toListId: z.string(),
    // The copy's card number, filled in by the recorder like `copyId`
    // so a redo recreates the same #N.
    copyNumber: z.number().int().positive().optional()
  }),
  z.object({
    type: z.literal('card.unspawnNext'),
    id: z.string(),
    copyId: z.string(),
    repeat: zCardRepeat
  }),

  // ADR-0036 · internal restore mutation used by the undo/redo flow.
  // `payload` is a discriminated snapshot of the entity to restore +
  // its dependents (card snapshots include checklists/items/comments/
  // attachments; list snapshots include their cards; board snapshots
  // include their lists). Loose payload validation here - the
  // applyMutation restore arm narrows by `kind` internally. This
  // mutation is NOT exposed to MCP (the control-channel allow-list in
  // apps/desktop/src/main/control-channel.ts deliberately excludes
  // 'restore') and is never fired by the renderer; main's undo
  // handler is the only producer.
  z.object({
    type: z.literal('restore'),
    payload: z
      .object({
        kind: z.enum([
          'card',
          'list',
          'board',
          'checklist',
          'checklistItem',
          'comment',
          'label',
          'attachment'
        ])
      })
      .passthrough()
  })
])
export type Mutation = z.infer<typeof zMutation>

/** Arms only the undo machinery may apply. Every external entry point
 *  (renderer IPC, control channel, batches) refuses them. */
export const INTERNAL_MUTATION_TYPES: ReadonlySet<Mutation['type']> = new Set([
  'restore',
  'card.spawnNext',
  'card.unspawnNext'
])

const namesCardNumber = (m: Mutation): boolean =>
  (m.type === 'card.create' || m.type === 'card.move' || m.type === 'card.copy') &&
  m.number !== undefined

const namesMoveLabels = (m: Mutation): boolean =>
  m.type === 'card.move' && m.labelIds !== undefined

/** True for a mutation only the undo machinery may apply: an internal
 *  arm, a card create / move / copy that names its card number, or a
 *  move that names the labels to arrive with. Only undo / redo hand a
 *  number back; from anyone else it could take a number out of turn or
 *  push the board's counter far ahead. */
export const isInternalMutation = (m: Mutation): boolean =>
  INTERNAL_MUTATION_TYPES.has(m.type) || namesCardNumber(m) || namesMoveLabels(m)

/** How an entry point names a mutation it refuses. */
export const mutationName = (m: Mutation): string =>
  namesCardNumber(m)
    ? `${m.type} with a card number`
    : namesMoveLabels(m)
      ? `${m.type} with label ids`
      : m.type

/** Every mutation returns the affected board (for scoped refetch). */
export const zMutationResult = z.object({
  id: z.string(),
  boardId: z.string().nullable()
})
export type MutationResult = z.infer<typeof zMutationResult>

/** Bulk gesture for IPC.mutateBatch - several mutations applied in one
 *  transaction and recorded under one undo-log group (one Ctrl+Z).
 *  Capped well above any realistic selection so a runaway caller can't
 *  stuff an unbounded payload through the boundary. */
export const zMutationBatch = z.array(zMutation).min(1).max(500)
export type MutationBatch = z.infer<typeof zMutationBatch>

export const zMutationResults = z.array(zMutationResult)
export type MutationResults = z.infer<typeof zMutationResults>

/** Pushed main → renderer after any successful mutation. */
export const zChangeEvent = z.object({
  boardId: z.string().nullable()
})
export type ChangeEvent = z.infer<typeof zChangeEvent>
