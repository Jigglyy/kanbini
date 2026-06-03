import { useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowRightLeft,
  Check,
  CheckSquare,
  Flag,
  Tag,
  Trash2,
  X
} from 'lucide-react'
import type { CardPriority, LabelView } from '@kanbini/shared'
import { PRIORITY_LEVELS, priorityColor, priorityLabel } from './priority'
import { Popover } from './ui/popover'
import { MenuItem, MenuLabel, MenuSep } from './ui/context-menu'
import { accentText } from '../lib/palette'

// Multi-select bulk actions (ADR-0035 follow-up). Two surfaces share one
// action set: a floating SelectionBar (discoverable, always visible while
// a selection exists) and a BulkCardMenu shown when you right-click a
// card that is part of the selection. Board owns the selection state and
// fires one mutation per card for each action; these components are pure
// presentation over the callbacks below.

export type LabelPresence = 'all' | 'some' | 'none'

export interface BulkActions {
  count: number
  /** True when every selected card is already complete (button label). */
  allComplete: boolean
  labels: LabelView[]
  /** Whether a label sits on all / some / none of the selected cards. */
  labelPresence: (labelId: string) => LabelPresence
  /** Visible lists a selection can be moved into. */
  lists: { id: string; name: string }[]
  onToggleComplete: () => void
  onSetPriority: (p: CardPriority | null) => void
  onToggleLabel: (labelId: string) => void
  onMoveTo: (listId: string) => void
  onDelete: () => void
  onClear: () => void
}

// ---------------------------------------------------------------------------
// Floating action bar
// ---------------------------------------------------------------------------

export function SelectionBar({ actions }: { actions: BulkActions }): React.ReactPortal | null {
  if (actions.count === 0) return null
  return createPortal(<SelectionBarInner actions={actions} />, document.body)
}

function SelectionBarInner({ actions }: { actions: BulkActions }): React.JSX.Element {
  const [confirmDelete, setConfirmDelete] = useState(false)
  return (
    <div
      data-overlay="selection-bar"
      className="fixed bottom-6 left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap items-center gap-1 rounded-xl border border-border bg-card/95 px-2 py-1.5 text-sm text-foreground shadow-lg backdrop-blur"
    >
      <span className="px-2 font-medium">{actions.count} selected</span>
      <Divider />

      {confirmDelete ? (
        <span className="flex items-center gap-1">
          <span className="px-1 text-xs text-muted-foreground">
            Delete {actions.count}?
          </span>
          <BarButton
            danger
            onClick={() => {
              actions.onDelete()
              setConfirmDelete(false)
            }}
          >
            <Trash2 className="size-3.5" /> Delete
          </BarButton>
          <BarButton onClick={() => setConfirmDelete(false)}>Cancel</BarButton>
        </span>
      ) : (
        <>
          <BarButton onClick={actions.onToggleComplete}>
            <CheckSquare className="size-3.5" />
            {actions.allComplete ? 'Uncomplete' : 'Complete'}
          </BarButton>

          <Popover
            width={188}
            trigger={({ toggle }) => (
              <BarButton onClick={toggle}>
                <Flag className="size-3.5" /> Priority
              </BarButton>
            )}
          >
            {(close) => (
              <PriorityRows
                onPick={(p) => {
                  actions.onSetPriority(p)
                  close()
                }}
              />
            )}
          </Popover>

          <Popover
            width={208}
            trigger={({ toggle }) => (
              <BarButton onClick={toggle}>
                <Tag className="size-3.5" /> Labels
              </BarButton>
            )}
          >
            {() => (
              <LabelRows
                labels={actions.labels}
                presence={actions.labelPresence}
                onToggle={actions.onToggleLabel}
              />
            )}
          </Popover>

          <Popover
            width={208}
            trigger={({ toggle }) => (
              <BarButton onClick={toggle} disabled={actions.lists.length === 0}>
                <ArrowRightLeft className="size-3.5" /> Move
              </BarButton>
            )}
          >
            {(close) => (
              <ListRows
                lists={actions.lists}
                onPick={(id) => {
                  actions.onMoveTo(id)
                  close()
                }}
              />
            )}
          </Popover>

          <BarButton danger onClick={() => setConfirmDelete(true)}>
            <Trash2 className="size-3.5" /> Delete
          </BarButton>
        </>
      )}

      <Divider />
      <BarButton onClick={actions.onClear} title="Clear selection (Esc)">
        <X className="size-3.5" /> Clear
      </BarButton>
      <span className="hidden px-1 text-xs text-muted-foreground sm:inline">
        Ctrl+click cards to select
      </span>
    </div>
  )
}

function Divider(): React.JSX.Element {
  return <span aria-hidden className="mx-0.5 h-5 w-px bg-border" />
}

function BarButton({
  children,
  onClick,
  danger,
  disabled,
  title
}: {
  children: React.ReactNode
  onClick: () => void
  danger?: boolean
  disabled?: boolean
  title?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        danger
          ? 'text-red-400 hover:bg-red-500/15'
          : 'text-foreground hover:bg-muted'
      }`}
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Shared picker bodies (used inside the bar's popovers)
// ---------------------------------------------------------------------------

function PriorityRows({
  onPick
}: {
  onPick: (p: CardPriority | null) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col">
      {PRIORITY_LEVELS.map((p) => (
        <RowButton key={p} onClick={() => onPick(p)}>
          <span
            aria-hidden
            className="inline-block size-2.5 rounded-full"
            style={{ backgroundColor: priorityColor(p) }}
          />
          {priorityLabel(p)}
        </RowButton>
      ))}
      <RowButton onClick={() => onPick(null)}>
        <span className="text-muted-foreground">No priority</span>
      </RowButton>
    </div>
  )
}

function LabelRows({
  labels,
  presence,
  onToggle
}: {
  labels: LabelView[]
  presence: (id: string) => LabelPresence
  onToggle: (id: string) => void
}): React.JSX.Element {
  if (labels.length === 0) {
    return <p className="px-1 text-xs text-muted-foreground">No labels yet.</p>
  }
  return (
    <div className="flex flex-col">
      {labels.map((l) => {
        const state = presence(l.id)
        return (
          <RowButton key={l.id} onClick={() => onToggle(l.id)}>
            <span
              className="flex max-w-[8rem] items-center truncate rounded-full px-2 py-0.5 text-[11px] font-medium"
              style={{ backgroundColor: l.color, color: accentText(l.color) }}
            >
              {l.name}
            </span>
            <span className="ml-auto text-muted-foreground">
              {state === 'all' ? (
                <Check className="size-3.5" />
              ) : state === 'some' ? (
                <span className="text-xs">some</span>
              ) : null}
            </span>
          </RowButton>
        )
      })}
    </div>
  )
}

function ListRows({
  lists,
  onPick
}: {
  lists: { id: string; name: string }[]
  onPick: (id: string) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col">
      {lists.map((l) => (
        <RowButton key={l.id} onClick={() => onPick(l.id)}>
          <span className="truncate">{l.name}</span>
        </RowButton>
      ))}
    </div>
  )
}

function RowButton({
  children,
  onClick
}: {
  children: React.ReactNode
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Right-click menu (rendered inside a card's ContextMenu when selected)
// ---------------------------------------------------------------------------

export function BulkCardMenu({
  actions,
  close
}: {
  actions: BulkActions
  close: () => void
}): React.JSX.Element {
  const act = (fn: () => void) => (): void => {
    fn()
    close()
  }
  return (
    <>
      <MenuLabel>{actions.count} cards selected</MenuLabel>
      <MenuItem onClick={act(actions.onToggleComplete)}>
        {actions.allComplete ? 'Mark incomplete' : 'Mark complete'}
      </MenuItem>

      <MenuSep />
      <MenuLabel>Priority</MenuLabel>
      {PRIORITY_LEVELS.map((p) => (
        <MenuItem key={p} onClick={act(() => actions.onSetPriority(p))}>
          <span className="inline-flex items-center gap-2">
            <span
              aria-hidden
              className="inline-block size-2.5 rounded-full"
              style={{ backgroundColor: priorityColor(p) }}
            />
            {priorityLabel(p)}
          </span>
        </MenuItem>
      ))}
      <MenuItem onClick={act(() => actions.onSetPriority(null))}>
        <span className="text-muted-foreground">No priority</span>
      </MenuItem>

      {actions.labels.length > 0 && (
        <>
          <MenuSep />
          <MenuLabel>Labels</MenuLabel>
          {actions.labels.map((l) => {
            const state = actions.labelPresence(l.id)
            return (
              <MenuItem
                key={l.id}
                onClick={() => actions.onToggleLabel(l.id)} // keep menu open
              >
                <span className="flex w-full items-center justify-between gap-2">
                  <span
                    className="max-w-[9rem] truncate rounded-full px-2 py-0.5 text-[11px] font-medium"
                    style={{
                      backgroundColor: l.color,
                      color: accentText(l.color)
                    }}
                  >
                    {l.name}
                  </span>
                  {state === 'all' ? (
                    <Check className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : state === 'some' ? (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      some
                    </span>
                  ) : null}
                </span>
              </MenuItem>
            )
          })}
        </>
      )}

      {actions.lists.length > 0 && (
        <>
          <MenuSep />
          <MenuLabel>Move to list</MenuLabel>
          {actions.lists.map((l) => (
            <MenuItem key={l.id} onClick={act(() => actions.onMoveTo(l.id))}>
              <span className="truncate">{l.name}</span>
            </MenuItem>
          ))}
        </>
      )}

      <MenuSep />
      <MenuItem danger onClick={act(actions.onDelete)}>
        Delete {actions.count} cards
      </MenuItem>
    </>
  )
}
