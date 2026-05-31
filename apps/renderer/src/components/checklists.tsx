import { useEffect, useState } from 'react'
import { Check, X } from 'lucide-react'
import type {
  BoardView,
  CardView,
  ChecklistItemView,
  ChecklistView,
  Mutation
} from '@kanbini/shared'
import type { Optimistic } from '../hooks/useBoardMutation'
import { cn } from '../lib/utils'
import { Tooltip } from './ui/tooltip'

// Per-checklist expanded state for the in-list card preview.
// Persisted to localStorage so a checklist you opened stays open after
// a refetch (the change-event bus invalidates the board query every
// time anything changes). Default = collapsed; matches Trello.
const EXPANDED_KEY = 'kanbini.expandedChecklists'

function loadExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? new Set(arr) : new Set()
  } catch {
    return new Set()
  }
}
const expandedIds = loadExpanded()
function persistExpanded(): void {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expandedIds]))
  } catch {
    /* private mode / quota - silent: state still works in-memory */
  }
}

// Card-detail checklists section: list each checklist with progress,
// inline rename / delete (with confirm), per-item checkbox + inline
// edit + delete, and an "add" affordance. Optimistic via the shared
// `apply` runner; the change-event bus reconciles on settle.

type Apply = (m: Mutation, o: Optimistic) => void

const mapCard = (
  b: BoardView,
  cardId: string,
  fn: (c: CardView) => CardView
): BoardView => ({
  ...b,
  lists: b.lists.map((l) => ({
    ...l,
    cards: l.cards.map((c) => (c.id === cardId ? fn(c) : c))
  }))
})

const mapChecklist = (
  card: CardView,
  checklistId: string,
  fn: (cl: ChecklistView) => ChecklistView
): CardView => ({
  ...card,
  checklists: card.checklists.map((cl) =>
    cl.id === checklistId ? fn(cl) : cl
  )
})

export function Checklists({
  card,
  apply
}: {
  card: CardView
  apply: Apply
}) {
  const addChecklist = (name: string): void => {
    const temp: ChecklistView = {
      id: `tmp-${crypto.randomUUID()}`,
      name,
      position: 'zzzz',
      items: []
    }
    apply({ type: 'checklist.create', cardId: card.id, name }, (b) =>
      mapCard(b, card.id, (c) => ({
        ...c,
        checklists: [...c.checklists, temp]
      }))
    )
  }

  return (
    <section className="flex flex-col gap-4">
      <h3 className="text-sm font-medium text-muted-foreground">Checklists</h3>
      {card.checklists.map((cl) => (
        <ChecklistBlock key={cl.id} cardId={card.id} checklist={cl} apply={apply} />
      ))}
      <AddChecklist onAdd={addChecklist} />
    </section>
  )
}

/** Compact, interactive checklist rendered on the in-list card
 *  (Settings → Card display → "Show checklists on cards"). Each
 *  checklist appears as a Trello-style pill - `[☑ 3/5]` - collapsed by
 *  default; clicking the pill expands the items so they can be ticked
 *  without opening the card detail. Per-checklist expanded state is
 *  persisted to localStorage. `apply` omitted = a static render, used
 *  by the drag overlay so the dragged card matches the resting one. */
export function CardChecklistPreview({
  card,
  apply
}: {
  card: CardView
  apply?: Apply
}) {
  const lists = card.checklists.filter((cl) => cl.items.length > 0)
  if (lists.length === 0) return null
  // When the whole card is done, every checklist line reads as done
  // too - otherwise a completed card with crisp checklist text looks
  // half-finished.
  const cardDone = card.completed
  return (
    <div className="flex flex-col gap-1">
      {lists.map((cl) => (
        <ChecklistPreviewRow
          key={cl.id}
          card={card}
          checklist={cl}
          cardDone={cardDone}
          apply={apply}
        />
      ))}
    </div>
  )
}

function ChecklistPreviewRow({
  card,
  checklist,
  cardDone,
  apply
}: {
  card: CardView
  checklist: ChecklistView
  cardDone: boolean
  apply?: Apply
}) {
  // Each row owns its own expanded state - toggling one checklist
  // doesn't disturb the others. Read the persisted Set once at mount;
  // toggling writes back so the choice survives a refetch / restart.
  const [expanded, setExpanded] = useState(() => expandedIds.has(checklist.id))
  const toggleExpanded = (): void => {
    setExpanded((prev) => {
      const next = !prev
      if (next) expandedIds.add(checklist.id)
      else expandedIds.delete(checklist.id)
      persistExpanded()
      return next
    })
  }

  const done = checklist.items.filter((i) => i.completed).length
  const total = checklist.items.length
  const allDone = done === total

  const toggleItem = (item: ChecklistItemView): void => {
    if (!apply) return
    apply(
      {
        type: 'checklistItem.update',
        id: item.id,
        patch: { completed: !item.completed }
      },
      (b) =>
        mapCard(b, card.id, (c) =>
          mapChecklist(c, checklist.id, (cl) => ({
            ...cl,
            items: cl.items.map((it) =>
              it.id === item.id ? { ...it, completed: !it.completed } : it
            )
          }))
        )
    )
  }

  return (
    <div className="flex flex-col">
      <Tooltip label={expanded ? 'Collapse checklist' : 'Expand checklist'}>
        <button
          type="button"
          onClick={toggleExpanded}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label={expanded ? 'Collapse checklist' : 'Expand checklist'}
          aria-expanded={expanded}
          className={cn(
            // -ml-1.5 cancels the pill's own px so its checkbox icon
            // lines up flush-left with the card-complete checkbox
            // above (and with the title text when that checkbox is
            // hidden). The hover/expanded background still has padding
            // around the icon - it just extends a few px into the
            // card's outer padding.
            '-ml-1.5 inline-flex w-fit items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums transition-colors',
            // Two distinct states: collapsed = quiet, expanded = an
            // obviously-active pill (muted bg + subtle ring), so an
            // open checklist reads as "open" at a glance.
            expanded
              ? allDone
                ? 'bg-primary/15 text-primary ring-1 ring-primary/40'
                : 'bg-muted text-foreground ring-1 ring-ring/40'
              : allDone
                ? 'text-primary hover:bg-muted'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          )}
        >
          {/* Same div+border pattern as the card-complete checkbox so
              their visual boxes align (an SVG icon's stroke is inset
              from its bounding box, which broke the column). */}
          <span
            className={cn(
              'flex size-3.5 shrink-0 items-center justify-center rounded border',
              allDone
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border'
            )}
          >
            {allDone && <Check className="size-2.5" />}
          </span>
          <span>
            {done}/{total}
          </span>
          {checklist.name && (
            <span className="ml-1 max-w-48 truncate font-normal">
              {checklist.name}
            </span>
          )}
        </button>
      </Tooltip>
      {expanded && (
        <div className="mt-1 flex flex-col gap-1 border-t border-border/70 pt-1.5">
          {checklist.items.map((it) => (
            <div key={it.id} className="flex items-start gap-1.5 text-xs">
              {/* Small target → stop pointerdown so a tick never starts
                  a drag (the text span stays a drag surface). */}
              <button
                aria-label={it.completed ? 'Mark incomplete' : 'Mark complete'}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => toggleItem(it)}
                className={cn(
                  'mt-0.5 flex size-3.5 shrink-0 cursor-pointer items-center justify-center rounded border',
                  it.completed
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border'
                )}
              >
                {it.completed && <Check className="size-2.5" />}
              </button>
              <span
                className={cn(
                  'min-w-0 flex-1 wrap-anywhere',
                  (it.completed || cardDone) &&
                    'text-muted-foreground line-through'
                )}
              >
                {it.text}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ChecklistBlock({
  cardId,
  checklist,
  apply
}: {
  cardId: string
  checklist: ChecklistView
  apply: Apply
}) {
  const [name, setName] = useState(checklist.name)
  const [confirming, setConfirming] = useState(false)
  // Re-sync the edit buffer if the checklist is renamed elsewhere
  // (AI via MCP / another window) so a stale buffer can't revert that
  // change on the next blur. Mirrors CardDetail's title handling.
  useEffect(() => setName(checklist.name), [checklist.name])
  const done = checklist.items.filter((i) => i.completed).length
  const total = checklist.items.length
  const pct = total === 0 ? 0 : Math.round((done / total) * 100)

  const rename = (): void => {
    const n = name.trim()
    if (!n || n === checklist.name) {
      setName(checklist.name)
      return
    }
    apply(
      { type: 'checklist.update', id: checklist.id, patch: { name: n } },
      (b) =>
        mapCard(b, cardId, (c) =>
          mapChecklist(c, checklist.id, (cl) => ({ ...cl, name: n }))
        )
    )
  }
  const del = (): void => {
    apply({ type: 'checklist.delete', id: checklist.id }, (b) =>
      mapCard(b, cardId, (c) => ({
        ...c,
        checklists: c.checklists.filter((cl) => cl.id !== checklist.id)
      }))
    )
  }
  const addItem = (text: string): void => {
    const temp: ChecklistItemView = {
      id: `tmp-${crypto.randomUUID()}`,
      text,
      completed: false,
      position: 'zzzz'
    }
    apply(
      { type: 'checklistItem.create', checklistId: checklist.id, text },
      (b) =>
        mapCard(b, cardId, (c) =>
          mapChecklist(c, checklist.id, (cl) => ({
            ...cl,
            items: [...cl.items, temp]
          }))
        )
    )
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-background/40 p-3">
      <div className="flex items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          onBlur={rename}
          className="-mx-1 flex-1 rounded border border-transparent bg-transparent px-1 text-sm font-medium hover:border-border focus:border-ring focus:outline-none"
        />
        <span className="text-xs tabular-nums text-muted-foreground">
          {done}/{total}
        </span>
        {confirming ? (
          <div className="flex items-center gap-1">
            <button
              onClick={() => setConfirming(false)}
              className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Cancel
            </button>
            <button
              onClick={del}
              className="rounded bg-red-500/90 px-1.5 py-0.5 text-xs text-white hover:bg-red-500"
            >
              Delete
            </button>
          </div>
        ) : (
          <button
            aria-label="Delete checklist"
            onClick={() => setConfirming(true)}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-primary transition-[width]"
          style={{ width: `${pct}%` }}
        />
      </div>

      <ul className="flex flex-col gap-0.5">
        {checklist.items.map((it) => (
          <ChecklistItemRow
            key={it.id}
            cardId={cardId}
            checklistId={checklist.id}
            item={it}
            apply={apply}
          />
        ))}
      </ul>

      <AddItem onAdd={addItem} />
    </div>
  )
}

function ChecklistItemRow({
  cardId,
  checklistId,
  item,
  apply
}: {
  cardId: string
  checklistId: string
  item: ChecklistItemView
  apply: Apply
}) {
  const [text, setText] = useState(item.text)
  const [editing, setEditing] = useState(false)
  // Re-sync if the item text changes externally - see ChecklistBlock.
  useEffect(() => setText(item.text), [item.text])

  const toggle = (): void => {
    apply(
      {
        type: 'checklistItem.update',
        id: item.id,
        patch: { completed: !item.completed }
      },
      (b) =>
        mapCard(b, cardId, (c) =>
          mapChecklist(c, checklistId, (cl) => ({
            ...cl,
            items: cl.items.map((it) =>
              it.id === item.id ? { ...it, completed: !it.completed } : it
            )
          }))
        )
    )
  }
  const saveText = (): void => {
    setEditing(false)
    const t = text.trim()
    if (!t || t === item.text) {
      setText(item.text)
      return
    }
    apply(
      {
        type: 'checklistItem.update',
        id: item.id,
        patch: { text: t }
      },
      (b) =>
        mapCard(b, cardId, (c) =>
          mapChecklist(c, checklistId, (cl) => ({
            ...cl,
            items: cl.items.map((it) =>
              it.id === item.id ? { ...it, text: t } : it
            )
          }))
        )
    )
  }
  const del = (): void => {
    apply({ type: 'checklistItem.delete', id: item.id }, (b) =>
      mapCard(b, cardId, (c) =>
        mapChecklist(c, checklistId, (cl) => ({
          ...cl,
          items: cl.items.filter((it) => it.id !== item.id)
        }))
      )
    )
  }

  return (
    <li className="group/item flex items-start gap-2 rounded px-1 py-1 hover:bg-muted/40">
      <button
        aria-label={item.completed ? 'Mark incomplete' : 'Mark complete'}
        onClick={toggle}
        className={`mt-0.5 flex size-4 shrink-0 cursor-pointer items-center justify-center rounded border ${
          item.completed
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-border'
        }`}
      >
        {item.completed && <Check className="size-3" />}
      </button>
      {editing ? (
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') {
              setText(item.text)
              setEditing(false)
            }
          }}
          onBlur={saveText}
          className="flex-1 rounded border border-border bg-background px-1.5 py-0.5 text-sm focus:border-ring focus:outline-none"
        />
      ) : (
        <span
          onClick={() => setEditing(true)}
          className={`flex-1 cursor-text text-sm ${
            item.completed ? 'text-muted-foreground line-through' : ''
          }`}
        >
          {item.text}
        </span>
      )}
      <button
        aria-label="Delete item"
        onClick={del}
        className="opacity-0 transition-opacity group-hover/item:opacity-100"
      >
        <X className="size-3.5 text-muted-foreground hover:text-foreground" />
      </button>
    </li>
  )
}

function AddItem({ onAdd }: { onAdd: (text: string) => void }) {
  const [value, setValue] = useState('')
  const submit = (): void => {
    const t = value.trim()
    if (!t) return
    onAdd(t)
    setValue('')
  }
  return (
    <input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && submit()}
      onBlur={submit}
      placeholder="+ Add an item"
      className="rounded border border-transparent bg-transparent px-1 py-1 text-sm placeholder:text-muted-foreground hover:border-border focus:border-ring focus:outline-none"
    />
  )
}

function AddChecklist({ onAdd }: { onAdd: (name: string) => void }) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-fit rounded border border-dashed border-border px-3 py-1.5 text-sm text-muted-foreground hover:border-ring hover:text-foreground"
      >
        + Add checklist
      </button>
    )
  }
  const submit = (): void => {
    const t = value.trim()
    if (t) onAdd(t)
    setValue('')
    setOpen(false)
  }
  return (
    <div className="flex items-center gap-2">
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') {
            setValue('')
            setOpen(false)
          }
        }}
        placeholder="Checklist name"
        className="flex-1 rounded border border-border bg-background px-2 py-1 text-sm focus:border-ring focus:outline-none"
      />
      <button
        onClick={submit}
        className="rounded bg-primary px-2 py-1 text-sm text-primary-foreground hover:bg-primary/90"
      >
        Add
      </button>
      <button
        onClick={() => {
          setValue('')
          setOpen(false)
        }}
        className="rounded px-2 py-1 text-sm text-muted-foreground hover:text-foreground"
      >
        Cancel
      </button>
    </div>
  )
}
