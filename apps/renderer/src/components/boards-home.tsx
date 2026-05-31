import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  defaultDropAnimationSideEffects,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DropAnimation
} from '@dnd-kit/core'
import {
  SortableContext,
  rectSortingStrategy,
  useSortable
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Archive,
  BookmarkPlus,
  Copy,
  Image as ImageIcon,
  PencilLine,
  Plus,
  Search,
  Star,
  Trash2,
  Upload
} from 'lucide-react'
import type { BoardSummary } from '@kanbini/shared'
import { boardsListKey } from '../hooks/useBoardsList'
import { boardsRootKey } from '../hooks/useBoard'
import { DROP_ANIMATION_DURATION_MS } from '../lib/drag-polish'
import { ipc } from '../lib/ipc'
import {
  computeBoardMoveStep,
  computeBoardMoveTarget,
  reduceBoardReorder
} from '../lib/boards-home-dnd'
import { loadOpenedMap } from '../lib/last-opened'
import { backgroundCss, swatchOptions } from '../lib/palette'
import { cn } from '../lib/utils'
import { BackgroundPicker } from './background-picker'
import { TemplatePickerDialog } from './templates'
import { Button } from './ui/button'
import { ContextMenu, MenuLabel, MenuSep } from './ui/context-menu'
import { Modal } from './ui/modal'

// Home picker (M4-G / ADR-0021). Single-user offline: flat grid of
// every non-archived board across the whole DB. Projects are hidden
// (the column still exists in the schema; the renderer just never
// surfaces them - see ADR-0021).
//
// M4-G+: each card carries an optional accent (top stripe + coloured
// border) and a star toggle. Pinned boards sort to the top; the star
// is always visible if pinned, fades in on hover otherwise.
// Right-click (or long-press) a card opens a context menu with the
// full board admin surface: rename / recolour / pin / archive / move
// up·down / duplicate / delete.

// Drag polish - mirror board.tsx: same DROP_ANIMATION_DURATION_MS
// two-keyframe drop with REST_SHADOW matched to the source's
// `:hover` shadow (`shadow-xl` here - boards-home cards bump to xl
// on hover, not md). The hover-style force on the source SortableCard
// (post-drop) lives in board.tsx and isn't replicated here because
// BoardCardFace has no hover-revealed surfaces to mismatch.
const LIFT_SHADOW = '0 14px 30px -8px rgb(0 0 0 / 0.55)'
const REST_SHADOW =
  '0 20px 25px -5px rgb(0 0 0 / 0.10), 0 8px 10px -6px rgb(0 0 0 / 0.10)'

const DROP_ANIMATION: DropAnimation = {
  duration: DROP_ANIMATION_DURATION_MS,
  easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
  keyframes: ({ transform }) => [
    {
      transform: CSS.Transform.toString(transform.initial) ?? '',
      boxShadow: LIFT_SHADOW
    },
    {
      transform: CSS.Transform.toString(transform.final) ?? '',
      boxShadow: REST_SHADOW
    }
  ],
  sideEffects: defaultDropAnimationSideEffects({
    styles: { active: { opacity: '0' } }
  })
}

// Fixed minimum so every card lines up regardless of whether it has a
// description. 9rem (144px) accommodates title + 2-line description +
// counts row + padding without making short cards feel padded out.
const CARD_MIN_HEIGHT = '9rem'

interface Props {
  boards: BoardSummary[]
  onOpen: (id: string) => void
}

type SortMode = 'manual' | 'opened' | 'recent' | 'name' | 'created'

const SORT_LABELS: Record<SortMode, string> = {
  manual: 'Manual',
  opened: 'Recently opened',
  recent: 'Recently updated',
  name: 'Name (A→Z)',
  created: 'Newest first'
}

// Persist the chosen sort across navigation + restart - coming back
// to the home picker shouldn't snap back to Manual every time.
const SORT_STORAGE_KEY = 'kanbini.boardsHomeSort'
function loadSortMode(): SortMode {
  try {
    const v = localStorage.getItem(SORT_STORAGE_KEY)
    if (v && v in SORT_LABELS) return v as SortMode
  } catch {
    /* private mode - fall through to default */
  }
  return 'manual'
}

export function BoardsHome({ boards, onOpen }: Props) {
  const qc = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [tplPickerOpen, setTplPickerOpen] = useState(false)
  const [renaming, setRenaming] = useState<BoardSummary | null>(null)
  const [bgPicker, setBgPicker] = useState<BoardSummary | null>(null)
  const [query, setQuery] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>(loadSortMode)
  useEffect(() => {
    try {
      localStorage.setItem(SORT_STORAGE_KEY, sortMode)
    } catch {
      /* private mode - sort still works in-memory */
    }
  }, [sortMode])
  const [showArchived, setShowArchived] = useState(false)
  const [dragging, setDragging] = useState<BoardSummary | null>(null)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  // Read the last-opened map once at mount. The map only changes when
  // a board is opened (which unmounts BoardsHome), so a snapshot is
  // sufficient - no subscribe pattern needed.
  const [openedMap] = useState(() => loadOpenedMap())

  // Trello import (ADR-0028). Additive - creates one new board and
  // drops the user straight into it; existing boards are untouched.
  // The picker doubles as the trigger; null summary = picker cancelled.
  async function runTrelloImport(): Promise<void> {
    if (importing) return
    setImporting(true)
    setImportError(null)
    try {
      const summary = await ipc.importTrello()
      if (!summary) return
      await Promise.all([
        qc.invalidateQueries({ queryKey: boardsListKey }),
        qc.invalidateQueries({ queryKey: boardsRootKey })
      ])
      onOpen(summary.boardId)
    } catch (e) {
      setImportError(
        e instanceof Error ? e.message : 'Could not import that Trello board.'
      )
    } finally {
      setImporting(false)
    }
  }

  // Filter: hide archived unless toggled; case-insensitive substring
  // match on name + description.
  const q = query.trim().toLowerCase()
  const filtered = boards.filter((b) => {
    if (!showArchived && b.archived) return false
    if (q === '') return true
    return (
      b.name.toLowerCase().includes(q) ||
      (b.description?.toLowerCase().includes(q) ?? false)
    )
  })

  // Sort: server returns (pinned desc, position asc); non-manual sorts
  // override the position layer but keep pinned-first as the outer
  // key - pinned boards always sit above unpinned ones, predictable.
  const visible =
    sortMode === 'manual'
      ? filtered
      : filtered.slice().sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
          if (sortMode === 'opened') {
            // Never-opened boards (no entry in the map) sort to the
            // bottom - `?? 0` puts them behind anything stamped.
            return (openedMap[b.id] ?? 0) - (openedMap[a.id] ?? 0)
          }
          if (sortMode === 'recent') return b.updatedAt - a.updatedAt
          if (sortMode === 'name') return a.name.localeCompare(b.name)
          /* created */ return b.createdAt - a.createdAt
        })

  const dndEnabled = sortMode === 'manual' && q === ''

  // "Move up/down" works within the same pin group so the visual
  // order matches the user's expectation (pinned cards never cross
  // the divider via this action - they're a different sort layer).
  function moveBoard(id: string, direction: 'up' | 'down'): void {
    const step = computeBoardMoveStep(visible, id, direction)
    if (!step) return
    mutateAndInvalidate(qc, {
      type: 'board.move',
      id,
      ...step
    }).catch(warnMutation)
  }

  // Same-pin-group siblings power the canMove* flags per card.
  const pinGroupIndex = (b: BoardSummary): { idx: number; total: number } => {
    const siblings = visible.filter((x) => x.pinned === b.pinned)
    return {
      idx: siblings.findIndex((x) => x.id === b.id),
      total: siblings.length
    }
  }

  // dnd-kit reorder. We mutate the boards-list query cache LIVE during
  // drag (mirror of board.tsx's pattern) so siblings animate under the
  // cursor and "drop = what you saw". onDragEnd reads the optimistic
  // cache to derive beforeId/afterId for the server's board.move.
  // Cross-pin-group drops are rejected in onDragOver - pinning is a
  // separate sort layer, not a position.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  )

  function applyCache(next: BoardSummary[]): void {
    qc.setQueryData<BoardSummary[]>(boardsListKey, next)
  }

  function onDragStart(e: DragStartEvent): void {
    const id = String(e.active.id)
    setDragging(boards.find((b) => b.id === id) ?? null)
  }

  function onDragOver(e: DragOverEvent): void {
    const { active, over } = e
    if (!over) return
    const prev = qc.getQueryData<BoardSummary[]>(boardsListKey)
    if (!prev) return
    const next = reduceBoardReorder(prev, String(active.id), String(over.id))
    if (next !== prev) applyCache(next)
  }

  function onDragEnd(e: DragEndEvent): void {
    setDragging(null)
    const { active, over } = e
    if (!over || active.id === over.id) return
    const cache = qc.getQueryData<BoardSummary[]>(boardsListKey)
    if (!cache) return
    const movedId = String(active.id)
    const target = computeBoardMoveTarget(cache, movedId)
    if (!target) return
    mutateAndInvalidate(qc, {
      type: 'board.move',
      id: movedId,
      ...target
    }).catch((e) => {
      // onDragOver already wrote the optimistic arrayMove into the
      // cache. On a successful move mutateAndInvalidate refetches and
      // corrects it; on failure nothing reconciles it - so invalidate
      // here too, pulling the canonical order back from the DB.
      warnMutation(e)
      void qc.invalidateQueries({ queryKey: boardsListKey })
    })
  }

  function onDragCancel(): void {
    setDragging(null)
  }

  const totalBoards = boards.length
  const archivedCount = boards.filter((b) => b.archived).length

  const grid = (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {visible.map((b) => {
        const { idx, total } = pinGroupIndex(b)
        const card = (
          <BoardCard
            board={b}
            onOpen={onOpen}
            onRequestRename={() => setRenaming(b)}
            onRequestBackground={() => setBgPicker(b)}
            canMoveUp={dndEnabled && idx > 0}
            canMoveDown={dndEnabled && idx < total - 1}
            onMoveUp={() => moveBoard(b.id, 'up')}
            onMoveDown={() => moveBoard(b.id, 'down')}
          />
        )
        return dndEnabled ? (
          <SortableBoardItem key={b.id} id={b.id}>
            {card}
          </SortableBoardItem>
        ) : (
          <li key={b.id}>{card}</li>
        )
      })}
    </ul>
  )

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-semibold tracking-tight">Your boards</h2>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="default"
            onClick={() => void runTrelloImport()}
            disabled={importing}
            title="Import a Trello board export (.json) as a new board"
          >
            <Upload className="size-4" />
            {importing ? 'Importing…' : 'Import from Trello'}
          </Button>
          <Button
            variant="outline"
            size="default"
            onClick={() => setTplPickerOpen(true)}
            title="Create a new board from a saved template"
          >
            <BookmarkPlus className="size-4" />
            From template
          </Button>
          <Button
            variant="default"
            size="default"
            onClick={() => setDialogOpen(true)}
          >
            <Plus className="size-4" />
            New board
          </Button>
        </div>
      </div>

      {importError && (
        <p className="rounded-md border border-red-500/40 bg-red-500/10 p-2.5 text-sm text-red-300">
          {importError}
        </p>
      )}

      {totalBoards > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <label className="relative flex-1 min-w-48">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter boards…"
              className="w-full rounded-md border border-input bg-background py-2 pl-8 pr-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>Sort</span>
            <select
              value={sortMode}
              onChange={(e) => {
                setSortMode(e.target.value as SortMode)
                // Drop focus immediately so the focus-ring artifact
                // doesn't linger on the native select after picking
                // a value with the mouse.
                e.currentTarget.blur()
              }}
              className="rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            >
              {(Object.keys(SORT_LABELS) as SortMode[]).map((m) => (
                <option key={m} value={m}>
                  {SORT_LABELS[m]}
                </option>
              ))}
            </select>
          </label>
          {archivedCount > 0 && (
            <button
              type="button"
              onClick={() => setShowArchived((v) => !v)}
              aria-pressed={showArchived}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                showArchived
                  ? 'border-primary/60 bg-accent text-foreground'
                  : 'border-input bg-background text-muted-foreground hover:text-foreground'
              )}
            >
              <Archive className="size-3.5" />
              {showArchived ? 'Hide archived' : 'Show archived'}
              <span className="text-xs text-muted-foreground">
                ({archivedCount})
              </span>
            </button>
          )}
        </div>
      )}

      {visible.length === 0 ? (
        totalBoards === 0 ? (
          <EmptyState onCreate={() => setDialogOpen(true)} />
        ) : (
          <p className="text-sm text-muted-foreground">
            No boards match{q !== '' ? ` “${query}”` : ' the current filter'}
          </p>
        )
      ) : dndEnabled ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={onDragCancel}
        >
          <SortableContext
            items={visible.map((b) => b.id)}
            strategy={rectSortingStrategy}
          >
            {grid}
          </SortableContext>
          <DragOverlay
            dropAnimation={DROP_ANIMATION}
            // LIFT_SHADOW lives on the overlay wrapper so dnd-kit's
            // drop animation can actually drive its fade-out. See
            // board.tsx for the full rationale. rounded-lg matches
            // BoardCardFace so the shadow follows the card's corners.
            style={{ boxShadow: LIFT_SHADOW, borderRadius: '0.5rem' }}
          >
            {dragging && (
              <div className="cursor-grabbing">
                <BoardCardFace board={dragging} lifted />
              </div>
            )}
          </DragOverlay>
        </DndContext>
      ) : (
        grid
      )}

      <NewBoardDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreated={(id) => {
          setDialogOpen(false)
          onOpen(id)
        }}
      />
      <TemplatePickerDialog
        open={tplPickerOpen}
        kind="board"
        onClose={() => setTplPickerOpen(false)}
        onCreated={({ boardId }) => onOpen(boardId)}
      />
      <RenameBoardDialog
        board={renaming}
        onClose={() => setRenaming(null)}
      />
      {/* ADR-0034 background picker - hosted at the top level (same
          pattern as rename) so it survives the right-click menu
          closing. One instance, swapped per board. */}
      {bgPicker && (
        <BackgroundPicker
          open
          boardId={bgPicker.id}
          value={bgPicker.background}
          apply={(m) => {
            mutateAndInvalidate(qc, m).catch(warnMutation)
          }}
          onClose={() => setBgPicker(null)}
        />
      )}
    </div>
  )
}

// Sortable wrapper: turns each grid cell into a dnd-kit sortable item.
// The whole <li> acts as the drag handle; the inner star + right-click
// remain interactive because they stopPropagation on pointer down.
// While dragging, the source li goes fully transparent so the floating
// DragOverlay is the only visible copy - clean hand-off, no double
// render. The drop-animation `sideEffects` keep the source hidden
// until the overlay lands on the new slot.
function SortableBoardItem({
  id,
  children
}: {
  id: string
  children: React.ReactNode
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id })
  return (
    <li
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        opacity: isDragging ? 0 : 1
      }}
    >
      {children}
    </li>
  )
}

function BoardCard({
  board,
  onOpen,
  onRequestRename,
  onRequestBackground,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown
}: {
  board: BoardSummary
  onOpen: (id: string) => void
  onRequestRename: () => void
  onRequestBackground: () => void
  canMoveUp: boolean
  canMoveDown: boolean
  onMoveUp: () => void
  onMoveDown: () => void
}) {
  const qc = useQueryClient()

  // The pin toggle is a sibling button (not nested inside the card
  // button - that's invalid HTML). The wrapper has `group` so the
  // unpinned star can fade in on the card's hover, not just its own.
  const togglePin = (): void => {
    mutateAndInvalidate(qc, {
      type: 'board.update',
      id: board.id,
      patch: { pinned: !board.pinned }
    }).catch(warnMutation)
  }

  return (
    <ContextMenu
      width={240}
      menu={(close) => (
        <BoardCardMenu
          board={board}
          canMoveUp={canMoveUp}
          canMoveDown={canMoveDown}
          onRequestRename={() => {
            onRequestRename()
            close()
          }}
          onRequestBackground={() => {
            onRequestBackground()
            close()
          }}
          onMoveUp={() => {
            onMoveUp()
            close()
          }}
          onMoveDown={() => {
            onMoveDown()
            close()
          }}
          close={close}
        />
      )}
    >
      {(open) => (
        // Hover lift lives on the wrapper so the absolutely-positioned
        // star moves with the card (children inherit the parent's
        // translate). Buttery transition: 220 ms with a long-tail ease
        // so the lift feels like it settles, not snaps.
        <div
          className="group relative h-full transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-1"
          style={{ minHeight: CARD_MIN_HEIGHT }}
          onContextMenu={open}
        >
          <button
            type="button"
            onClick={() => onOpen(board.id)}
            className="flex h-full w-full"
          >
            <BoardCardFace board={board} interactive />
          </button>

          <button
            type="button"
            onClick={(e) => {
              togglePin()
              // Drop focus immediately after click so the star doesn't
              // stick in its post-click visible state on mouse use.
              ;(e.currentTarget as HTMLButtonElement).blur()
            }}
            // Stop the pointer event from bubbling to the sortable
            // handle - otherwise tapping the star starts a drag instead
            // of toggling pin.
            onPointerDown={(e: PointerEvent<HTMLButtonElement>) =>
              e.stopPropagation()
            }
            aria-label={
              board.pinned ? 'Unfavorite board' : 'Favorite board'
            }
            aria-pressed={board.pinned}
            className={cn(
              'absolute right-3 top-3 z-10 inline-flex size-7 items-center justify-center rounded-md transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              'hover:bg-background/70',
              board.pinned
                ? 'text-amber-500 opacity-100'
                : // focus-visible (not focus) so mouse clicks don't
                  // keep the star pinned in its visible state after the
                  // click handler drops focus.
                  'text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
            )}
          >
            <Star
              className={cn('size-4', board.pinned ? 'fill-current' : '')}
            />
          </button>
        </div>
      )}
    </ContextMenu>
  )
}

// Static card visual - shared between the in-grid card (wrapped in
// the click button) and the DragOverlay, so a dragged card looks
// pixel-identical to its resting state (no jump on lift).
function BoardCardFace({
  board,
  interactive = false,
  lifted = false
}: {
  board: BoardSummary
  /** Apply hover styles + the focus ring (true when inside the click
   *  button); false for the DragOverlay copy. */
  interactive?: boolean
  /** True when rendered inside the DragOverlay. Used only to drop
   *  the resting `shadow-sm` - the lift shadow itself lives on the
   *  DragOverlay wrapper so the drop animation can actually animate
   *  it (see board.tsx for the full rationale). */
  lifted?: boolean
}) {
  const bg = backgroundCss(board.background)
  const hasBg = bg.image || bg.color
  return (
    <div
      style={{
        ...(board.color ? { borderColor: board.color } : undefined),
        ...(bg.image ? { backgroundImage: bg.image } : undefined),
        ...(bg.color ? { backgroundColor: bg.color } : undefined),
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        minHeight: CARD_MIN_HEIGHT
      }}
      className={cn(
        'flex h-full w-full flex-col overflow-hidden rounded-lg border text-left transition-[background-color,border-color,box-shadow] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]',
        // Default surface only when the user hasn't set a background;
        // a custom bg owns the surface so the card-tone doesn't dim it.
        hasBg ? '' : 'bg-card',
        board.color ? '' : 'border-border',
        interactive && !board.color ? 'hover:border-primary/60' : '',
        // Lift is on the wrapper (so the star moves with the card);
        // the face only handles colour + shadow on hover.
        interactive
          ? hasBg
            ? 'hover:shadow-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
            : 'hover:bg-accent hover:shadow-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
          : '',
        board.archived ? 'opacity-60 hover:opacity-90' : '',
        !lifted ? 'shadow-sm' : ''
      )}
    >
      {board.color && (
        <div
          aria-hidden
          className="h-1.5 w-full"
          style={{ backgroundColor: board.color }}
        />
      )}
      {/* Bottom content gradient over a bg image so text stays
          readable on whatever wallpaper the user picked. No-op
          (transparent) when there's no image. */}
      <div
        className={cn(
          'flex flex-1 flex-col gap-3 p-4',
          bg.image && 'bg-linear-to-t from-black/60 via-black/20 to-transparent text-white'
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="min-w-0 flex-1 truncate pr-7 text-base font-semibold">
              {board.name}
            </h3>
            {board.archived && (
              <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Archived
              </span>
            )}
          </div>
          {board.description && (
            <p
              className={cn(
                'mt-1 line-clamp-2 text-sm wrap-anywhere',
                bg.image ? 'text-white/85' : 'text-muted-foreground'
              )}
            >
              {board.description}
            </p>
          )}
        </div>
        <div
          className={cn(
            'flex items-center justify-between text-xs',
            bg.image ? 'text-white/80' : 'text-muted-foreground'
          )}
        >
          <span>
            {board.listCount} {board.listCount === 1 ? 'list' : 'lists'} ·{' '}
            {board.cardCount} {board.cardCount === 1 ? 'card' : 'cards'}
          </span>
          <span>{relativeTime(board.updatedAt)}</span>
        </div>
      </div>
    </div>
  )
}

function BoardCardMenu({
  board,
  canMoveUp,
  canMoveDown,
  onRequestRename,
  onRequestBackground,
  onMoveUp,
  onMoveDown,
  close
}: {
  board: BoardSummary
  canMoveUp: boolean
  canMoveDown: boolean
  onRequestRename: () => void
  onRequestBackground: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  close: () => void
}) {
  const qc = useQueryClient()
  const [confirming, setConfirming] = useState(false)

  // Every menu item is "dispatch a mutation, swallow errors, close
  // the menu" - one helper keeps each handler a one-liner.
  const fire = (m: Parameters<typeof ipc.mutate>[0]): void => {
    mutateAndInvalidate(qc, m).catch(warnMutation)
    close()
  }

  const update = (
    patch: Extract<
      Parameters<typeof ipc.mutate>[0],
      { type: 'board.update' }
    >['patch']
  ): void => fire({ type: 'board.update', id: board.id, patch })

  // No-op if it's already this colour (clicking the ring'd current
  // swatch, incl. the orphaned one swatchOptions surfaces) - skips a
  // redundant board.update + junk undo entry.
  const setColor = (color: string | null): void => {
    if (color !== board.color) update({ color })
  }
  const togglePinFromMenu = (): void => update({ pinned: !board.pinned })
  const toggleArchive = (): void => update({ archived: !board.archived })
  const duplicate = (): void => fire({ type: 'board.duplicate', id: board.id })
  const del = (): void => fire({ type: 'board.delete', id: board.id })

  return (
    <>
      <MenuRow icon={<PencilLine className="size-3.5" />} onClick={onRequestRename}>
        Rename…
      </MenuRow>
      <MenuSep />
      <MenuLabel>Colour</MenuLabel>
      <div className="flex flex-wrap items-center gap-1.5 px-2 py-1">
        {swatchOptions(board.color).map((c) => (
          <button
            key={c}
            onClick={() => setColor(c)}
            className={cn(
              'size-5 rounded-full',
              board.color === c ? 'ring-2 ring-ring' : ''
            )}
            style={{ backgroundColor: c }}
            aria-label={`Colour ${c}`}
          />
        ))}
        <button
          onClick={() => setColor(null)}
          className="ml-1 text-xs text-muted-foreground hover:text-foreground"
        >
          None
        </button>
      </div>
      <MenuRow
        icon={<ImageIcon className="size-3.5" />}
        onClick={onRequestBackground}
      >
        Background…
      </MenuRow>
      <MenuSep />
      <MenuRow
        icon={
          <Star
            className={cn(
              'size-3.5',
              board.pinned ? 'fill-current text-amber-500' : ''
            )}
          />
        }
        onClick={togglePinFromMenu}
      >
        {board.pinned ? 'Unfavorite' : 'Favorite'}
      </MenuRow>
      <MenuRow
        icon={<ArrowUp className="size-3.5" />}
        onClick={onMoveUp}
        disabled={!canMoveUp}
      >
        Move up
      </MenuRow>
      <MenuRow
        icon={<ArrowDown className="size-3.5" />}
        onClick={onMoveDown}
        disabled={!canMoveDown}
      >
        Move down
      </MenuRow>
      <MenuSep />
      <MenuRow icon={<Copy className="size-3.5" />} onClick={duplicate}>
        Duplicate
      </MenuRow>
      <MenuRow
        icon={
          board.archived ? (
            <ArchiveRestore className="size-3.5" />
          ) : (
            <Archive className="size-3.5" />
          )
        }
        onClick={toggleArchive}
      >
        {board.archived ? 'Unarchive' : 'Archive'}
      </MenuRow>
      <MenuSep />
      {confirming ? (
        <div className="flex flex-col gap-1 px-1">
          <span className="px-1 text-xs text-muted-foreground">
            Delete “{board.name}” and all its lists/cards? You can undo this with Ctrl+Z.
          </span>
          <div className="flex gap-1">
            <button
              onClick={() => setConfirming(false)}
              className="flex-1 rounded px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Cancel
            </button>
            <button
              onClick={del}
              className="flex-1 rounded bg-red-500/90 px-2 py-1.5 text-sm text-white hover:bg-red-500"
            >
              Delete
            </button>
          </div>
        </div>
      ) : (
        <MenuRow
          icon={<Trash2 className="size-3.5" />}
          onClick={() => setConfirming(true)}
          danger
        >
          Delete board…
        </MenuRow>
      )}
    </>
  )
}

function MenuRow({
  icon,
  onClick,
  disabled,
  danger,
  children
}: {
  icon?: React.ReactNode
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors',
        disabled
          ? 'cursor-not-allowed text-muted-foreground/60'
          : danger
            ? 'text-red-400 hover:bg-muted hover:text-red-300'
            : 'text-foreground hover:bg-muted'
      )}
    >
      {icon && (
        <span
          className={cn(
            'inline-flex w-4 justify-center',
            disabled ? 'opacity-60' : ''
          )}
        >
          {icon}
        </span>
      )}
      {children}
    </button>
  )
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-card/40 p-12 text-center">
      <p className="text-sm text-muted-foreground">
        No boards yet. Create your first board to get started.
      </p>
      <Button onClick={onCreate}>
        <Plus className="size-4" />
        Create your first board
      </Button>
    </div>
  )
}

function NewBoardDialog({
  open,
  onClose,
  onCreated
}: {
  open: boolean
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) return
    // Reset whenever the dialog re-opens.
    setName('')
    setDescription('')
    setError(null)
    // Defer the focus until after the portal renders.
    queueMicrotask(() => nameRef.current?.focus())
  }, [open])

  async function submit(): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await ipc.mutate({
        type: 'board.create',
        name: trimmed,
        description: description.trim() || undefined
      })
      // Refresh both the home list and the per-board cache prefix.
      // The main-process change-event also fires, but invalidating
      // here makes the open-after-create transition feel instant.
      await Promise.all([
        qc.invalidateQueries({ queryKey: boardsListKey }),
        qc.invalidateQueries({ queryKey: boardsRootKey })
      ])
      onCreated(result.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the board.')
      setSubmitting(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} label="New board">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        className="flex flex-col gap-4 p-6"
      >
        <h2 className="text-lg font-semibold">New board</h2>
        <label className="flex flex-col gap-1 text-sm">
          <span>Name</span>
          <input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            required
            disabled={submitting}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="flex items-center justify-between">
            <span>Description</span>
            <span className="text-xs text-muted-foreground">optional</span>
          </span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            maxLength={2000}
            disabled={submitting}
            className="resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={!name.trim() || submitting}>
            {submitting ? 'Creating…' : 'Create board'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

// Rename dialog mirrors NewBoardDialog's shape so the form feels
// identical, but submits a board.update patch with the new name +
// optional description. Pre-filled from the selected board.
function RenameBoardDialog({
  board,
  onClose
}: {
  board: BoardSummary | null
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!board) return
    setName(board.name)
    setDescription(board.description ?? '')
    setError(null)
    queueMicrotask(() => {
      nameRef.current?.focus()
      nameRef.current?.select()
    })
  }, [board])

  async function submit(): Promise<void> {
    if (!board || submitting) return
    const trimmedName = name.trim()
    if (!trimmedName) return
    const trimmedDesc = description.trim()
    const patch: { name?: string; description?: string | null } = {}
    if (trimmedName !== board.name) patch.name = trimmedName
    const currentDesc = board.description ?? ''
    if (trimmedDesc !== currentDesc) {
      patch.description = trimmedDesc === '' ? null : trimmedDesc
    }
    if (Object.keys(patch).length === 0) {
      onClose()
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await mutateAndInvalidate(qc, {
        type: 'board.update',
        id: board.id,
        patch
      })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save changes.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal open={board !== null} onClose={onClose} label="Rename board">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        className="flex flex-col gap-4 p-6"
      >
        <h2 className="text-lg font-semibold">Rename board</h2>
        <label className="flex flex-col gap-1 text-sm">
          <span>Name</span>
          <input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            required
            disabled={submitting}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="flex items-center justify-between">
            <span>Description</span>
            <span className="text-xs text-muted-foreground">optional</span>
          </span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            maxLength={2000}
            disabled={submitting}
            className="resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={!name.trim() || submitting}>
            {submitting ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

// Mini helper used by every BoardCard mutation that doesn't live on
// the optimistic useBoardMutation path: dispatch through the
// control-channel-shared `mutate` IPC and invalidate the home query.
// `boardsRootKey` is also invalidated because some mutations (delete,
// duplicate, archive) materially change which BoardView is on screen.
// Throws on failure - fire-and-forget call sites use `.catch(warn)`;
// awaited call sites (the rename dialog) can show an inline error.
async function mutateAndInvalidate(
  qc: QueryClient,
  m: Parameters<typeof ipc.mutate>[0]
): Promise<void> {
  await ipc.mutate(m)
  await Promise.all([
    qc.invalidateQueries({ queryKey: boardsListKey }),
    qc.invalidateQueries({ queryKey: boardsRootKey })
  ])
}

const warnMutation = (e: unknown): void => {
  console.warn('boards-home mutation failed:', e)
}

const RTF = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

function relativeTime(ms: number): string {
  const diffMs = ms - Date.now()
  const abs = Math.abs(diffMs)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  const week = 7 * day
  const month = 30 * day
  const year = 365 * day
  if (abs < minute) return 'just now'
  if (abs < hour) return RTF.format(Math.round(diffMs / minute), 'minute')
  if (abs < day) return RTF.format(Math.round(diffMs / hour), 'hour')
  if (abs < week) return RTF.format(Math.round(diffMs / day), 'day')
  if (abs < month) return RTF.format(Math.round(diffMs / week), 'week')
  if (abs < year) return RTF.format(Math.round(diffMs / month), 'month')
  return RTF.format(Math.round(diffMs / year), 'year')
}
