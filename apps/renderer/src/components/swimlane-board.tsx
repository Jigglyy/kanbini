import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { useDroppable } from '@dnd-kit/core'
import type {
  BoardView,
  CardPriority,
  CardView,
  Mutation,
  SwimlaneMode
} from '@kanbini/shared'
import type { Optimistic } from '../hooks/useBoardMutation'
import { AddCard, AddList, ListHeader } from './board'
import { priorityColor } from './priority'

// ADR-0037 slice 2 · swimlane layout for a board.
//
// Renders the board as N lane rows × M list columns instead of the
// flat row-of-lists. Each (list, lane) cell is its own droppable +
// SortableContext so dnd-kit can route cards between cells. The
// parent <Board> still owns <DndContext> and the drag handlers; this
// component only renders the grid and the per-cell droppables. The
// existing SortableCard is reused - its keyboard / context-menu
// behaviour is identical between layouts.
//
// Lane key encoding in droppable ids: `lane:<key>:list:<listId>`.
// `<key>` for priority mode is one of urgent / high / medium / low /
// none. `none` is the literal lane for null priority - cards stay
// unprioritised when they land there.
//
// What this v1 does NOT do (deliberately, to keep the diff bounded):
//   - Live optimistic priority change during onDragOver - cards
//     "jump" to the new lane on drop instead of gliding. Same-lane
//     reorder is still smooth via the existing arrayMove path.
//   - Label-based swimlanes (`label:<id>` mode). Schema supports it,
//     renderer doesn't. Follow-up.
//   - Per-cell AddCard. New cards land in the No-priority lane via
//     the existing per-list AddCard - users promote with right-click
//     or a cross-lane drag.

interface LaneDef {
  /** Stable lane id used in droppable ids + React keys. */
  key: string
  label: string
  /** Card's matching field value - `card.priority === priority` puts
   *  it in this lane. `null` means "unprioritised". */
  priority: CardPriority | null
  /** Lane-header colour (matches priority badge colours). null for
   *  the No-priority lane → neutral muted stripe. */
  color: string | null
}

// Lane-header colours come straight from the priority badge palette
// (priority.tsx) so the swimlane headers and the card flags never
// drift apart - they used to be a hardcoded copy that fell out of sync
// when the priority ramp was re-tuned (ADR-0060).
const PRIORITY_LANES: readonly LaneDef[] = [
  { key: 'urgent', label: 'Urgent', priority: 'urgent', color: priorityColor('urgent') },
  { key: 'high', label: 'High', priority: 'high', color: priorityColor('high') },
  { key: 'medium', label: 'Medium', priority: 'medium', color: priorityColor('medium') },
  { key: 'low', label: 'Low', priority: 'low', color: priorityColor('low') },
  { key: 'none', label: 'No priority', priority: null, color: null }
]

export function lanesForMode(mode: SwimlaneMode): readonly LaneDef[] {
  // `mode` is typed as the only currently-supported literal; the
  // switch is here so adding `'label:<id>'` later is a structured
  // extension instead of a one-liner sprinkled at every call site.
  switch (mode) {
    case 'priority':
      return PRIORITY_LANES
  }
}

/** Parse a swimlane droppable id back into its parts. Returns null
 *  for non-lane ids (card ids, `list:<id>` from flat mode, etc.) so
 *  the caller can fall through to the existing handlers. */
export function parseLaneDroppable(
  id: string
): { laneKey: string; listId: string } | null {
  if (!id.startsWith('lane:')) return null
  // Encoding is `lane:<key>:list:<id>` - slice off the prefix, find
  // the `:list:` separator. lane keys never contain `:list:` (they
  // are a closed enum today; future label-mode keys will be
  // `label:<labelId>` which contains a single `:` but never `:list:`).
  const rest = id.slice('lane:'.length)
  const sep = rest.indexOf(':list:')
  if (sep < 0) return null
  return {
    laneKey: rest.slice(0, sep),
    listId: rest.slice(sep + ':list:'.length)
  }
}

/** Which lane (by key) a given card belongs to under the supplied
 *  mode. Used by the DnD handler to decide whether a drop changed
 *  the lane and a priority update needs to fire. */
export function laneKeyOfCard(card: CardView, _mode: SwimlaneMode): string {
  return card.priority ?? 'none'
}

export function SwimlaneBoard({
  board,
  mode,
  renderCards,
  addList,
  apply,
  blockCreate
}: {
  board: BoardView
  mode: SwimlaneMode
  /** The parent owns SortableCard rendering (keyboard focus, menu,
   *  etc.); we just supply (list, lane, cards) so it can paint them
   *  inside the right SortableContext. Returning a fragment of
   *  <SortableCard /> elements is exactly what the existing flat
   *  layout does - we just wrap them in a per-cell SortableContext. */
  renderCards: (
    list: BoardView['lists'][number],
    laneKey: string,
    cards: CardView[]
  ) => React.ReactNode
  /** Used by the regular kanban-row AddList trigger underneath the
   *  grid - same input + shortcut handler the flat layout uses. */
  addList: (name: string) => void
  /** Needed by the top row of ListHeaders so the pencil-rename / sort
   *  / WIP-limit menu works against the board's mutation channel.
   *  Also drives the per-cell AddCard (one mutation per submission,
   *  optimistic write inserts the new card into the correct lane). */
  apply: (m: Mutation, o: Optimistic) => void
  /** Mirror of settings.cardLimitBlocksCreate - drives the per-cell
   *  AddCard's `full` state so card-limited lists show the "Card
   *  limit reached" message instead of the add-card input. */
  blockCreate: boolean
}) {
  const lanes = lanesForMode(mode)
  const visibleLists = board.lists.filter((l) => !l.closed)
  return (
    // The whole board scrolls horizontally as one unit - header row +
    // every lane row use the same `w-72` columns + `gap-4`, wrapped
    // here in `min-w-max` so they all reach the right edge together
    // when a board is wider than the viewport. Without `min-w-max`
    // the header row + lane rows would each get their own scroll
    // width and could visually misalign on wide boards.
    <div className="flex min-w-max flex-col gap-6">
      {/* List-headers row - rendered ONCE at the top of the swimlane
          view. Cells below intentionally drop their own header so the
          list title doesn't repeat in every lane (visually noisy).
          Each header is the same `w-72` column the cells use, so they
          line up directly above their respective list columns. */}
      <div className="flex items-start gap-4">
        {visibleLists.map((list) => (
          <div
            key={list.id}
            style={list.color ? { borderColor: list.color } : undefined}
            className={`flex w-72 shrink-0 overflow-hidden rounded-lg border ${
              list.color ? '' : 'border-border'
            } bg-muted/60`}
          >
            <div className="w-full">
              <ListHeader list={list} apply={apply} />
            </div>
          </div>
        ))}
      </div>

      {lanes.map((lane) => (
        <LaneRow
          key={lane.key}
          lane={lane}
          visibleLists={visibleLists}
          renderCards={renderCards}
          apply={apply}
          blockCreate={blockCreate}
        />
      ))}
      {/* Reuse the regular kanban-row AddList - same inline input
          + `kanbini:add-list` shortcut handler - so creating a new
          column works identically in either layout. Sits under the
          grid; a new list shows up as a fresh column across every
          lane on the next refetch. */}
      <div className="flex">
        <AddList onAdd={addList} boardId={board.board.id} />
      </div>
    </div>
  )
}

function LaneRow({
  lane,
  visibleLists,
  renderCards,
  apply,
  blockCreate
}: {
  lane: LaneDef
  visibleLists: BoardView['lists']
  renderCards: (
    list: BoardView['lists'][number],
    laneKey: string,
    cards: CardView[]
  ) => React.ReactNode
  apply: (m: Mutation, o: Optimistic) => void
  blockCreate: boolean
}) {
  // Cards-in-this-lane per list. Filtered before the cell renders so
  // each per-cell SortableContext gets a tight items array (dnd-kit
  // matches sortable ids to their nearest SortableContext for the
  // measurement loop - bigger arrays = slower).
  const buckets = visibleLists.map((list) => ({
    list,
    cards: list.cards.filter(
      (c) => (c.priority ?? null) === lane.priority
    )
  }))
  return (
    <section className="flex flex-col gap-2">
      <LaneHeader lane={lane} total={buckets.reduce((n, b) => n + b.cards.length, 0)} />
      <div className="flex items-start gap-4">
        {buckets.map(({ list, cards }) => (
          <LaneCell
            key={list.id}
            list={list}
            laneKey={lane.key}
            lanePriority={lane.priority}
            cards={cards}
            renderCards={renderCards}
            apply={apply}
            blockCreate={blockCreate}
          />
        ))}
      </div>
    </section>
  )
}

function LaneHeader({ lane, total }: { lane: LaneDef; total: number }) {
  return (
    <div className="flex items-center gap-2 px-1">
      <span
        aria-hidden
        className="inline-block size-2.5 rounded-full"
        style={{ backgroundColor: lane.color ?? 'var(--color-muted-foreground)' }}
      />
      <h3 className="text-sm font-medium text-foreground">{lane.label}</h3>
      <span className="text-xs text-muted-foreground">{total}</span>
    </div>
  )
}

function LaneCell({
  list,
  laneKey,
  lanePriority,
  cards,
  renderCards,
  apply,
  blockCreate
}: {
  list: BoardView['lists'][number]
  laneKey: string
  /** The lane's matching card.priority value - preset onto each card
   *  created from this cell's AddCard so it lands in this lane
   *  immediately (no follow-up move/update). null = the No-priority
   *  lane; new cards stay unprioritised. ADR-0037 slice 2. */
  lanePriority: CardPriority | null
  cards: CardView[]
  renderCards: (
    list: BoardView['lists'][number],
    laneKey: string,
    cards: CardView[]
  ) => React.ReactNode
  apply: (m: Mutation, o: Optimistic) => void
  blockCreate: boolean
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `lane:${laneKey}:list:${list.id}`
  })
  // Card-limit applies to the whole list (not the lane). The same
  // input/full-state model as the flat layout's AddCard, just
  // mirrored into every cell of the list so the user can add from
  // wherever they're looking.
  const atLimit =
    list.wipLimit != null && list.cards.length >= list.wipLimit
  return (
    <section
      ref={setNodeRef}
      style={list.color ? { borderColor: list.color } : undefined}
      // No per-cell header - the top row carries the list title once.
      // Cells get a subtle border + bg so they still read as discrete
      // (list, lane) droppables and `isOver` highlight has somewhere
      // to land. Min-height keeps empty cells targetable for drag.
      className={`flex min-h-16 w-72 shrink-0 flex-col overflow-hidden rounded-lg border pb-1 transition-colors ${
        list.color ? '' : 'border-border'
      } ${isOver ? 'bg-muted' : 'bg-muted/40'}`}
    >
      <SortableContext
        items={cards.map((c) => c.id)}
        strategy={verticalListSortingStrategy}
      >
        <ul className="flex min-h-8 flex-col gap-2 px-2 pt-2">
          {renderCards(list, laneKey, cards)}
        </ul>
      </SortableContext>

      {/* Per-cell AddCard - presets the new card's priority to this
          lane so it lands here immediately. The optimistic write
          mirrors that: the new card object goes into list.cards with
          the right priority, which puts it in this cell on render.
          Limit check is on the *whole list* (cards across all lanes),
          mirroring how `card.create` actually validates server-side. */}
      <AddCard
        listId={list.id}
        full={atLimit && blockCreate}
        onAdd={(title) =>
          apply(
            {
              type: 'card.create',
              listId: list.id,
              title,
              priority: lanePriority
            },
            (b) => ({
              ...b,
              lists: b.lists.map((l) =>
                l.id === list.id
                  ? {
                      ...l,
                      cards: [
                        ...l.cards,
                        {
                          id: `tmp-${crypto.randomUUID()}`,
                          title,
                          description: null,
                          position: 'zzzz',
                          completed: false,
                          dueAt: null,
                          priority: lanePriority,
                          labelIds: [],
                          checklists: [],
                          comments: [],
                          attachments: [],
                          coverAttachmentId: null,
                          activities: []
                        }
                      ]
                    }
                  : l
              )
            })
          )
        }
      />
    </section>
  )
}
