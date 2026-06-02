import { useMemo, useState } from 'react'
import { Tag } from 'lucide-react'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  rectSortingStrategy,
  useSortable
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { BoardView, CardView, LabelView, Mutation } from '@kanbini/shared'
import type { Optimistic } from '../hooks/useBoardMutation'
import { projectReorder } from '../lib/label-order'
import { ACCENTS, accentText, swatchOptions } from '../lib/palette'
import { Popover } from './ui/popover'
import { ContextMenu, MenuItem, MenuLabel, MenuSep } from './ui/context-menu'

// Labels: filter/create bar (header), card chips, and a reusable
// toggle list used inside the card context menu. Optimistic via the
// shared `apply` runner.

export type Apply = (m: Mutation, o: Optimistic) => void

// Faint, theme-aware hairline for the no-text colour bars. A bar whose
// colour sits near the surface lightness washes out (light accents on a
// white card in light theme; dark accents on a dark card in dark theme);
// a foreground-tinted inset edge always contrasts the surface, so it
// delineates the soft end of the palette on either theme. Chips don't
// need it - their text carries them.
const BAR_EDGE =
  'inset 0 0 0 1px color-mix(in oklab, var(--color-foreground) 18%, transparent)'

// Filter-chip elevation, built as one box-shadow string (an inline
// boxShadow would clobber any Tailwind shadow/ring class, and the edge /
// ring need to be theme-aware). CHIP_EDGE de-emphasises an UNSELECTED
// chip with a faint inset hairline (echoing BAR_EDGE) instead of fading
// the whole thing to 80% - which muddied the colour. CHIP_RING marks the
// active filter with a neutral foreground outline plus a 1px surface gap,
// so the selected state never fights the chip's own colour the way the
// old primary-blue ring did. CHIP_LIFT / CHIP_DRAG_LIFT give the pill a
// little depth (the bigger one replaces the former drag `shadow-lg`).
const CHIP_EDGE =
  'inset 0 0 0 1px color-mix(in oklab, var(--color-foreground) 16%, transparent)'
const CHIP_RING =
  '0 0 0 1px var(--color-background), 0 0 0 3px var(--color-foreground)'
const CHIP_LIFT = '0 1px 2px rgba(0, 0, 0, 0.18)'
const CHIP_DRAG_LIFT = '0 8px 18px rgba(0, 0, 0, 0.35)'

export const withLabels = (
  b: BoardView,
  cardId: string,
  labelIds: string[]
): BoardView => ({
  ...b,
  lists: b.lists.map((l) => ({
    ...l,
    cards: l.cards.map((c) => (c.id === cardId ? { ...c, labelIds } : c))
  }))
})

/** Optimistic projection for a label rename / recolour - patches the
 *  one label in `board.labels` so every chip (card previews, filter
 *  bar) reflects it instantly. */
export const withLabelUpdate = (
  b: BoardView,
  id: string,
  patch: { name?: string; color?: string }
): BoardView => ({
  ...b,
  labels: b.labels.map((l) => (l.id === id ? { ...l, ...patch } : l))
})

/** Optimistic projection for a label delete - drops it from
 *  `board.labels` AND from every card that carried it, so no card is
 *  left referencing a label that no longer exists. */
export const withLabelDelete = (b: BoardView, id: string): BoardView => ({
  ...b,
  labels: b.labels.filter((l) => l.id !== id),
  lists: b.lists.map((l) => ({
    ...l,
    cards: l.cards.map((c) =>
      c.labelIds.includes(id)
        ? { ...c, labelIds: c.labelIds.filter((x) => x !== id) }
        : c
    )
  }))
})

/** Header bar: toggle labels as filters + create new ones. The chips
 *  render in `labels` order (the caller layers the manual order in).
 *  Reorder by dragging a chip (`onReorder`, drop active->over); the
 *  right-click editor's `onMove` left/right stays as the keyboard /
 *  no-pointer fallback. */
export function LabelBar({
  boardId,
  labels,
  active,
  onToggle,
  onMove,
  onReorder,
  apply
}: {
  boardId: string
  labels: LabelView[]
  active: ReadonlySet<string>
  onToggle: (id: string) => void
  /** Move a label one slot left (-1) / right (+1) in the bar. */
  onMove?: (id: string, dir: -1 | 1) => void
  /** Drag reorder: persist the bar's final left-to-right id order. */
  onReorder?: (orderedIds: string[]) => void
  apply: Apply
}) {
  // Distance constraint so a plain click still toggles the filter and a
  // right-click still opens the editor - only a deliberate drag past
  // 6px starts a reorder (mirrors the card SortableContext, ADR-0035).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  )

  // Live reorder (mirrors the board's onDragOver pattern). While a chip
  // is being dragged we reorder a LOCAL id list as it crosses each
  // neighbour, and render the chips in that order, so the browser's
  // flex-wrap layout positions every chip at its real width. The old
  // approach left ordering to dnd-kit's rectSortingStrategy, which aligns
  // each shifted chip's LEFT edge to a slot measured from the original
  // layout - so a wide chip nudged into a narrow chip's slot overflowed
  // to the right and overlapped the "New label" button. Letting real
  // layout do the work sidesteps that and also handles the wrapped case.
  const [dragOrder, setDragOrder] = useState<string[] | null>(null)
  const ordered = useMemo(() => {
    if (!dragOrder) return labels
    const byId = new Map(labels.map((l) => [l.id, l]))
    const seen = new Set(dragOrder)
    // Known ids in the live drag order, then any label created mid-drag.
    return [
      ...dragOrder
        .map((id) => byId.get(id))
        .filter((l): l is LabelView => l != null),
      ...labels.filter((l) => !seen.has(l.id))
    ]
  }, [dragOrder, labels])

  const handleDragStart = (e: DragStartEvent): void => {
    // Seed the live order, and pin the just-grabbed chip's order so a
    // drag that never crosses a neighbour still has a list to commit.
    void e
    setDragOrder(labels.map((l) => l.id))
  }
  const handleDragOver = (e: DragOverEvent): void => {
    const { active: a, over } = e
    if (!over || a.id === over.id) return
    setDragOrder((prev) =>
      projectReorder(prev ?? labels.map((l) => l.id), String(a.id), String(over.id))
    )
  }
  const handleDragEnd = (e: DragEndEvent): void => {
    void e
    const original = labels.map((l) => l.id)
    const final = dragOrder ?? original
    setDragOrder(null)
    if (final.some((id, i) => id !== original[i])) onReorder?.(final)
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setDragOrder(null)}
      >
        <SortableContext
          items={ordered.map((l) => l.id)}
          // rectSortingStrategy (not horizontal/vertical) because the bar
          // is flex-wrap with variable-width chips - the list strategies
          // assume a single non-wrapping row. With the live reorder above
          // the chips are already in their final slots, so the strategy
          // only has to carry the dragged chip under the cursor.
          strategy={rectSortingStrategy}
        >
          {ordered.map((l, i) => (
            <SortableLabelChip
              key={l.id}
              label={l}
              on={active.has(l.id)}
              onToggle={onToggle}
              apply={apply}
              onMoveLeft={onMove && i > 0 ? () => onMove(l.id, -1) : undefined}
              onMoveRight={
                onMove && i < ordered.length - 1
                  ? () => onMove(l.id, 1)
                  : undefined
              }
            />
          ))}
        </SortableContext>
      </DndContext>

      <Popover
        width={224}
        trigger={({ toggle }) => (
          <button
            onClick={toggle}
            className="flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <Tag className="size-3" /> New label
          </button>
        )}
      >
        {(close) => <CreateLabel boardId={boardId} apply={apply} close={close} />}
      </Popover>
    </div>
  )
}

/** One draggable filter chip. The whole chip is the drag handle (like a
 *  card `<li>`); the 6px activation distance disambiguates a click
 *  (toggle filter) and a right-click (open editor) from a drag. */
function SortableLabelChip({
  label,
  on,
  onToggle,
  apply,
  onMoveLeft,
  onMoveRight
}: {
  label: LabelView
  on: boolean
  onToggle: (id: string) => void
  apply: Apply
  onMoveLeft?: () => void
  onMoveRight?: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: label.id })
  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    backgroundColor: label.color,
    color: accentText(label.color),
    // One composed shadow: the selected ring OR the unselected edge, plus
    // the lift (bigger while dragging). No DragOverlay here, so the SAME
    // chip follows the cursor - this keeps it solid + lifted above its
    // neighbours while they slide aside.
    boxShadow: `${on ? CHIP_RING : CHIP_EDGE}, ${
      isDragging ? CHIP_DRAG_LIFT : CHIP_LIFT
    }`,
    zIndex: isDragging ? 20 : undefined,
    touchAction: 'none'
  }
  return (
    <ContextMenu
      width={224}
      menu={(close) => (
        <LabelEditor
          label={label}
          apply={apply}
          close={close}
          onMoveLeft={onMoveLeft}
          onMoveRight={onMoveRight}
        />
      )}
    >
      {(open) => (
        <button
          ref={setNodeRef}
          style={style}
          {...attributes}
          {...listeners}
          // Toggle button: announce the filter on/off state (also the
          // stable hook for the selected-state ring, which is an inline
          // theme-aware box-shadow rather than a class).
          aria-pressed={on}
          onClick={() => onToggle(label.id)}
          onContextMenu={open}
          title={
            on
              ? 'Filtering by this label (drag to reorder, right-click to edit)'
              : 'Filter by this label (drag to reorder, right-click to edit)'
          }
          className={`flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium transition-[filter] duration-150 ${
            isDragging ? 'cursor-grabbing' : 'cursor-grab hover:brightness-110'
          }`}
        >
          {label.name}
        </button>
      )}
    </ContextMenu>
  )
}

function CreateLabel({
  boardId,
  apply,
  close
}: {
  boardId: string
  apply: Apply
  close: () => void
}) {
  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(ACCENTS[0])
  const create = (): void => {
    const n = name.trim()
    if (!n) return
    apply({ type: 'label.create', boardId, name: n, color }, (b) => ({
      ...b,
      labels: [...b.labels, { id: `tmp-${crypto.randomUUID()}`, name: n, color }]
    }))
    close()
  }
  return (
    <>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && create()}
        placeholder="Label name"
        className="rounded border border-border bg-background px-2 py-1 text-sm focus:border-ring focus:outline-none"
      />
      <div className="flex flex-wrap gap-1.5">
        {ACCENTS.map((c) => (
          <button
            key={c}
            onClick={() => setColor(c)}
            className={`size-5 rounded-full ${color === c ? 'ring-2 ring-ring' : ''}`}
            style={{ backgroundColor: c }}
            aria-label={`Pick ${c}`}
          />
        ))}
      </div>
      <button
        onClick={create}
        className="rounded bg-primary px-2 py-1 text-sm text-primary-foreground hover:bg-primary/90"
      >
        Add label
      </button>
    </>
  )
}

/** Right-click editor for an existing label (opened from the filter
 *  bar's ContextMenu): rename, recolour, or delete. Rename commits on
 *  Enter / the Save button; a colour swatch commits immediately and
 *  keeps the menu open so name + colour can both be changed in one
 *  pass. Both go through the standard optimistic `apply` so every chip
 *  on the board updates live. */
function LabelEditor({
  label,
  apply,
  close,
  onMoveLeft,
  onMoveRight
}: {
  label: LabelView
  apply: Apply
  close: () => void
  /** Reorder the chip in the bar; undefined at the respective edge. */
  onMoveLeft?: () => void
  onMoveRight?: () => void
}) {
  const [name, setName] = useState(label.name)
  const saveName = (): void => {
    const n = name.trim()
    if (!n || n === label.name) {
      close()
      return
    }
    apply({ type: 'label.update', id: label.id, patch: { name: n } }, (b) =>
      withLabelUpdate(b, label.id, { name: n })
    )
    close()
  }
  const setColor = (color: string): void => {
    if (color === label.color) return
    apply({ type: 'label.update', id: label.id, patch: { color } }, (b) =>
      withLabelUpdate(b, label.id, { color })
    )
  }
  const remove = (): void => {
    apply({ type: 'label.delete', id: label.id }, (b) =>
      withLabelDelete(b, label.id)
    )
    close()
  }
  return (
    <>
      <MenuLabel>Rename label</MenuLabel>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') saveName()
        }}
        placeholder="Label name"
        className="mx-1 rounded border border-border bg-background px-2 py-1 text-sm focus:border-ring focus:outline-none"
      />
      <MenuLabel>Colour</MenuLabel>
      <div className="flex flex-wrap gap-1.5 px-2 py-1">
        {swatchOptions(label.color).map((c) => (
          <button
            key={c}
            onClick={() => setColor(c)}
            className={`size-5 rounded-full ${label.color === c ? 'ring-2 ring-ring' : ''}`}
            style={{ backgroundColor: c }}
            aria-label={`Colour ${c}`}
          />
        ))}
      </div>
      <button
        onClick={saveName}
        className="mx-1 rounded bg-primary px-2 py-1 text-sm text-primary-foreground hover:bg-primary/90"
      >
        Save name
      </button>
      {(onMoveLeft || onMoveRight) && (
        <>
          <MenuSep />
          <MenuLabel>Reorder</MenuLabel>
          {onMoveLeft && (
            <MenuItem
              onClick={() => {
                onMoveLeft()
                close()
              }}
            >
              ← Move left
            </MenuItem>
          )}
          {onMoveRight && (
            <MenuItem
              onClick={() => {
                onMoveRight()
                close()
              }}
            >
              → Move right
            </MenuItem>
          )}
        </>
      )}
      <MenuSep />
      <MenuItem danger onClick={remove}>
        Delete label
      </MenuItem>
    </>
  )
}

/** Labels shown on a card. Two display modes:
 *
 *  - `expanded` (default): named chips - used by the card detail and
 *    whenever the board-wide "show label names" toggle is on.
 *  - collapsed (`expanded={false}`): compact colour bars with no text
 *    (Trello-style), so a card carrying both labels AND a priority
 *    doesn't read as two competing colour bands.
 *
 *  When `onToggleExpand` is supplied the bars/chips become buttons that
 *  flip the board-wide setting (click a bar to reveal names, click a
 *  name to collapse). Without it - the drag overlay (a frozen clone)
 *  and the card detail - they render inert so they can't start a drag
 *  or fire stray state writes. Interactive children stop pointerdown
 *  propagation so a click on a bar never starts a card drag. */
export function CardLabels({
  labelIds,
  labels,
  expanded = true,
  onToggleExpand
}: {
  labelIds: string[]
  labels: LabelView[]
  expanded?: boolean
  onToggleExpand?: () => void
}) {
  if (labelIds.length === 0) return null
  const byId = new Map(labels.map((l) => [l.id, l]))
  const resolved = labelIds
    .map((id) => byId.get(id))
    .filter((l): l is LabelView => l != null)
  if (resolved.length === 0) return null

  if (!expanded) {
    return (
      <div className="flex flex-wrap gap-1">
        {resolved.map((l) =>
          onToggleExpand ? (
            <button
              key={l.id}
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                onToggleExpand()
              }}
              title={`${l.name} (click to show label names)`}
              aria-label={`Label ${l.name}. Show label names`}
              className="h-2 w-10 rounded-sm"
              style={{ backgroundColor: l.color, boxShadow: BAR_EDGE }}
            />
          ) : (
            <span
              key={l.id}
              title={l.name}
              aria-label={`Label ${l.name}`}
              className="h-2 w-10 rounded-sm"
              style={{ backgroundColor: l.color, boxShadow: BAR_EDGE }}
            />
          )
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-wrap gap-1">
      {resolved.map((l) =>
        onToggleExpand ? (
          <button
            key={l.id}
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onToggleExpand()
            }}
            title="Click to hide label names"
            className="rounded-sm px-1.5 text-[10px] leading-4"
            style={{ backgroundColor: l.color, color: accentText(l.color) }}
          >
            {l.name}
          </button>
        ) : (
          <span
            key={l.id}
            className="rounded-sm px-1.5 text-[10px] leading-4"
            style={{ backgroundColor: l.color, color: accentText(l.color) }}
          >
            {l.name}
          </span>
        )
      )}
    </div>
  )
}

/** Toggleable label rows for the card context menu (multi-select). */
export function LabelToggleList({
  card,
  labels,
  apply
}: {
  card: CardView
  labels: LabelView[]
  apply: Apply
}) {
  if (labels.length === 0) {
    return (
      <span className="px-2 py-1 text-xs text-muted-foreground">
        No labels yet. Add some from the header.
      </span>
    )
  }
  const toggle = (labelId: string): void => {
    const next = card.labelIds.includes(labelId)
      ? card.labelIds.filter((x) => x !== labelId)
      : [...card.labelIds, labelId]
    apply({ type: 'card.setLabels', id: card.id, labelIds: next }, (b) =>
      withLabels(b, card.id, next)
    )
  }
  return (
    <>
      {labels.map((l) => {
        const on = card.labelIds.includes(l.id)
        return (
          <button
            key={l.id}
            onClick={() => toggle(l.id)}
            className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted"
          >
            <span
              className="size-3 rounded-sm"
              style={{ backgroundColor: l.color }}
            />
            <span className="flex-1 text-left">{l.name}</span>
            {on && <span className="text-muted-foreground">✓</span>}
          </button>
        )
      })}
    </>
  )
}
