import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text
} from 'drizzle-orm/sqlite-core'

// Kanbini schema v1 (DESIGN §6, ADR-0011).
// - ids: UUIDv7 TEXT, minted by @kanbini/shared `newId()` at the
//   service layer (the single writer).
// - ordering: `position` fractional-index string on orderable rows.
// - timestamps: epoch milliseconds (INTEGER); SQL default so raw
//   inserts are still stamped. `updatedAt` is bumped by the service.
// - booleans: INTEGER 0/1 via drizzle boolean mode.
// FK enforcement requires `PRAGMA foreign_keys = ON` (set in client.ts).

const nowMs = sql`(unixepoch() * 1000)`

/** Columns every table carries. */
const timestamps = {
  createdAt: integer('created_at').notNull().default(nowMs),
  updatedAt: integer('updated_at').notNull().default(nowMs)
}

export const project = sqliteTable('project', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  color: text('color'),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  ...timestamps
})

export const board = sqliteTable(
  'board',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    // Optional accent (M4-G+): rendered as a top stripe + coloured
    // border on the home picker card and tints the board-view header.
    // Same palette as lists; null = neutral default.
    color: text('color'),
    position: text('position').notNull(),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    // Pinned boards always sort to the top of the home picker (M4-G+).
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    // Optional rich background painted behind the lists / on the home
    // picker card (ADR-0034). Discriminated JSON:
    //   {kind:'color', value:'#hex|oklch(…)'}
    // | {kind:'gradient', preset:'sunset'|…}
    // | {kind:'image', relPath:'board-backgrounds/<id>/<file>'}
    // null = neutral / use `color` only. Independent of `color` -
    // `color` still tints header + list stripes regardless of bg.
    // Stored as JSON via drizzle's `mode: 'json'`; the shared
    // `zBoardBackground` schema narrows the unknown at the boundary.
    background: text('background', { mode: 'json' }),
    // ADR-0037 slice 2 · per-board swimlane mode. null = off
    // (today's default - flat row of lists). 'priority' = group
    // cards into horizontal lanes by `card.priority`. Stored as
    // plain text so future modes (`'label:<id>'`) can ride in
    // without a migration; the renderer parses defensively.
    swimlaneMode: text('swimlane_mode'),
    ...timestamps
  },
  (t) => [index('idx_board_project').on(t.projectId, t.position)]
)

export const list = sqliteTable(
  'list',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => board.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color'),
    position: text('position').notNull(),
    closed: integer('closed', { mode: 'boolean' }).notNull().default(false),
    // Optional card limit (UI label: "Card limit"). null = no limit.
    // Always surfaced as a count/limit badge on the list header;
    // whether it also blocks new cards / drag-in is two renderer
    // settings (cardLimitBlocks{Create,Drag}), both on by default.
    // Internal name kept as `wipLimit` - the standard kanban term.
    wipLimit: integer('wip_limit'),
    // Per-list sort override (ADR-0032). null = manual (today's
    // default) - cards stay in user-chosen fractional-index order.
    // When set, getBoardView orders the list's cards by created_at;
    // the renderer freezes DnD on that list (no drag source, no
    // drop target). Flipping back to null snapshots the displayed
    // order into fresh positions inside the same transaction so the
    // manual order matches what the user just saw.
    sortMode: text('sort_mode'),
    // ADR-0041 · per-list automation that fires when a card enters
    // the list. Discriminated JSON:
    //   {kind:'complete'}   - flip completed = true on entry
    //   {kind:'uncomplete'} - flip completed = false on entry
    // null = no automation (today's default). Applied INSIDE the
    // `card.move` transaction so the rule + the move land atomically.
    // `mode: 'json'` so drizzle round-trips the object cleanly;
    // future kinds (`'set-label'`, …) extend the union without a
    // migration. Renderer + db both soft-narrow unknown shapes to
    // null and skip the rule rather than throw.
    onEnter: text('on_enter', { mode: 'json' }),
    ...timestamps
  },
  (t) => [index('idx_list_board').on(t.boardId, t.position)]
)

export const card = sqliteTable(
  'card',
  {
    id: text('id').primaryKey(),
    listId: text('list_id')
      .notNull()
      .references(() => list.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    position: text('position').notNull(),
    dueAt: integer('due_at'),
    completed: integer('completed', { mode: 'boolean' })
      .notNull()
      .default(false),
    // App-enforced (no FK) to avoid a card<->attachment reference cycle.
    coverAttachmentId: text('cover_attachment_id'),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    // Optional priority (ADR-0037). One of 'low' | 'medium' | 'high' |
    // 'urgent' - null = unprioritised (today's default). Surfaced as a
    // small chip on the in-list card preview and the primary key for
    // the swimlanes view. Validated at the mutation boundary; stored
    // as plain text so future values (e.g. 'critical') can ride in
    // without a schema migration.
    priority: text('priority'),
    // ADR-0032 follow-up: epoch-ms of when the card was added to its
    // CURRENT list. Stamped on create and on every cross-list move
    // (an in-list reorder leaves it alone); powers the "added to list"
    // sort modes. `$defaultFn` injects Date.now() from the ORM on any
    // insert that omits it, so every create path (card.create,
    // templates, Trello import, the sample-board seed) gets the right
    // value without each call site having to set it. The migration that
    // adds this column uses a constant default + a one-shot back-fill to
    // created_at (SQLite forbids a function default on ADD COLUMN), so
    // cards that predate the column sort as if added when created.
    listAddedAt: integer('list_added_at')
      .notNull()
      .$defaultFn(() => Date.now()),
    ...timestamps
  },
  (t) => [
    index('idx_card_list').on(t.listId, t.position),
    index('idx_card_due').on(t.dueAt),
    // Swimlanes (ADR-0037 slice 2) group by priority across the
    // whole board - this keeps that lookup cheap on multi-thousand-
    // card boards.
    index('idx_card_priority').on(t.priority)
  ]
)

export const label = sqliteTable(
  'label',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => board.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull(),
    ...timestamps
  },
  (t) => [index('idx_label_board').on(t.boardId)]
)

export const cardLabel = sqliteTable(
  'card_label',
  {
    cardId: text('card_id')
      .notNull()
      .references(() => card.id, { onDelete: 'cascade' }),
    labelId: text('label_id')
      .notNull()
      .references(() => label.id, { onDelete: 'cascade' })
  },
  (t) => [
    primaryKey({ columns: [t.cardId, t.labelId] }),
    index('idx_card_label_label').on(t.labelId)
  ]
)

export const checklist = sqliteTable(
  'checklist',
  {
    id: text('id').primaryKey(),
    cardId: text('card_id')
      .notNull()
      .references(() => card.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    position: text('position').notNull(),
    ...timestamps
  },
  (t) => [index('idx_checklist_card').on(t.cardId, t.position)]
)

export const checklistItem = sqliteTable(
  'checklist_item',
  {
    id: text('id').primaryKey(),
    checklistId: text('checklist_id')
      .notNull()
      .references(() => checklist.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    completed: integer('completed', { mode: 'boolean' })
      .notNull()
      .default(false),
    position: text('position').notNull(),
    ...timestamps
  },
  (t) => [index('idx_checklist_item_checklist').on(t.checklistId, t.position)]
)

export const comment = sqliteTable(
  'comment',
  {
    id: text('id').primaryKey(),
    cardId: text('card_id')
      .notNull()
      .references(() => card.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    // null = the human user; 'ai' tags AI-authored notes (DESIGN §6).
    author: text('author'),
    ...timestamps
  },
  (t) => [index('idx_comment_card').on(t.cardId)]
)

export const attachment = sqliteTable(
  'attachment',
  {
    id: text('id').primaryKey(),
    cardId: text('card_id')
      .notNull()
      .references(() => card.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    // Relative to userData/attachments/ (DESIGN §3) - portable in export.
    relPath: text('rel_path').notNull(),
    mime: text('mime'),
    size: integer('size'),
    // URL-sourced cover provenance (ADR-0023, M4-H). Both null for
    // local-file attachments; both set when the image came from main's
    // link-preview fetcher so the renderer can render a URL chip on
    // top of the cover and the card detail can link out.
    sourceUrl: text('source_url'),
    sourceTitle: text('source_title'),
    createdAt: integer('created_at').notNull().default(nowMs)
  },
  (t) => [index('idx_attachment_card').on(t.cardId)]
)

export const activity = sqliteTable(
  'activity',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id').references(() => board.id, {
      onDelete: 'cascade'
    }),
    cardId: text('card_id').references(() => card.id, { onDelete: 'set null' }),
    type: text('type').notNull(),
    data: text('data', { mode: 'json' }),
    createdAt: integer('created_at').notNull().default(nowMs)
  },
  (t) => [
    index('idx_activity_board').on(t.boardId, t.createdAt),
    index('idx_activity_card').on(t.cardId, t.createdAt)
  ]
)

/** ADR-0036 · server-side undo/redo log. One row per recorded
 *  mutation, with both the forward mutation (for redo) and the
 *  inverse mutation (for undo) stored as JSON. Status flips between
 *  'undoable' (in the undo stack) and 'undone' (in the redo stack).
 *
 *  - boardId is nullable: cross-board operations (board.create,
 *    project.* if we ever surface them) don't have a single board scope.
 *  - description: short human-readable label for future "Undo: Move
 *    card X" hints. Not currently shown anywhere; populated for
 *    forward compatibility + log debugging.
 *  - status: 'undoable' = in the undo stack; 'undone' = in the redo
 *    stack (undone but redoable). A new mutation clears every 'undone'
 *    entry (standard editor model).
 *
 *  Capped at MAX_UNDO_LOG_SIZE (100, tuned in ADR-0036 revision 4) -
 *  oldest undoable rows are dropped first when a new mutation pushes
 *  the count over the cap. */
export const undoLog = sqliteTable(
  'undo_log',
  {
    id: text('id').primaryKey(),
    createdAt: integer('created_at').notNull().default(nowMs),
    boardId: text('board_id'),
    description: text('description').notNull(),
    forward: text('forward', { mode: 'json' }).notNull(),
    inverse: text('inverse', { mode: 'json' }).notNull(),
    status: text('status', { enum: ['undoable', 'undone'] })
      .notNull()
      .default('undoable')
  },
  (t) => [index('idx_undo_log_status_created').on(t.status, t.createdAt)]
)

export const template = sqliteTable('template', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['board', 'list'] }).notNull(),
  data: text('data', { mode: 'json' }).notNull(),
  ...timestamps
})
