import {
  Archive,
  CalendarClock,
  CheckSquare,
  ChevronsDownUp,
  ChevronsUpDown,
  FileImage,
  Flag,
  Globe,
  Image as ImageIcon,
  ImageOff,
  Repeat,
  Tag,
  Trash2
} from 'lucide-react'
import {
  describeRepeat,
  type BoardView,
  type CardView,
  type LabelView,
  type Mutation
} from '@kanbini/shared'
import type { Optimistic } from '../hooks/useBoardMutation'
import { dueLabel } from '../lib/due-presets'
import { ipc } from '../lib/ipc'
import { LabelToggleList } from './labels'
import { DueEditor } from './due-date'
import { PriorityPicker, priorityLabel } from './priority'
import { RepeatPicker } from './repeat'
import { MenuItem, MenuSep, SubMenu } from './ui/context-menu'

// Content of a card's right-click menu. The settings with several
// options (labels, due date, repeat, priority, cover) are fly-out rows
// that show the current value; the one-click actions sit below them.

type Apply = (m: Mutation, o: Optimistic) => void

const mapCard = (
  b: BoardView,
  id: string,
  fn: (c: CardView) => CardView
): BoardView => ({
  ...b,
  lists: b.lists.map((l) => ({
    ...l,
    cards: l.cards.map((c) => (c.id === id ? fn(c) : c))
  }))
})

const dropCard = (b: BoardView, id: string): BoardView => ({
  ...b,
  lists: b.lists.map((l) => ({
    ...l,
    cards: l.cards.filter((c) => c.id !== id)
  }))
})

/** An icon + text row label (MenuItem lays its children out as-is). */
function Row({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="inline-flex w-4 justify-center text-muted-foreground">{icon}</span>
      {children}
    </span>
  )
}

export function CardMenu({
  card,
  labels,
  apply,
  close,
  onRequestCoverFromUrl,
  compact,
  onToggleCollapse
}: {
  card: CardView
  labels: LabelView[]
  apply: Apply
  close: () => void
  /** Lifted to the parent (SortableCard) so the URL modal survives
   *  this menu closing - ContextMenu unmounts its panel on close. */
  onRequestCoverFromUrl: () => void
  /** Whether the card currently renders compact, and the toggle that
   *  flips it (owned by SortableCard, which knows the list's density).
   *  Optional so hosts without a list context omit the item. */
  compact?: boolean
  onToggleCollapse?: () => void
}) {
  // "Set cover from file" is two awaited IPC calls (upload + set
  // cover). Bypasses the optimistic helper because the new
  // attachment id is only known after the upload completes; the
  // broadcastChange after card.update reconciles the cache.
  const setCoverFromFile = async (): Promise<void> => {
    close()
    try {
      const att = await ipc.attachmentAdd(card.id)
      if (!att) return // user cancelled the native file dialog
      await ipc.mutate({
        type: 'card.update',
        id: card.id,
        patch: { coverAttachmentId: att.id }
      })
    } catch (e) {
      console.warn('set cover from file failed:', e)
    }
  }

  const removeCover = (): void => {
    apply(
      { type: 'card.update', id: card.id, patch: { coverAttachmentId: null } },
      (b) => mapCard(b, card.id, (c) => ({ ...c, coverAttachmentId: null }))
    )
    close()
  }

  const labelNames = card.labelIds
    .map((id) => labels.find((l) => l.id === id)?.name)
    .filter((n): n is string => !!n)

  return (
    <>
      {/* Stays open while you tick: toggling a label doesn't close it. */}
      <SubMenu
        id="labels"
        label="Labels"
        icon={<Tag className="size-3.5" />}
        value={labelNames.length > 0 ? labelNames.join(', ') : 'None'}
      >
        <LabelToggleList card={card} labels={labels} apply={apply} />
      </SubMenu>
      <SubMenu
        id="due"
        label="Due date"
        icon={<CalendarClock className="size-3.5" />}
        value={card.dueAt != null ? dueLabel(card.dueAt) : 'None'}
        width={260}
      >
        <DueEditor card={card} apply={apply} close={close} />
      </SubMenu>
      <SubMenu
        id="repeat"
        label="Repeat"
        icon={<Repeat className="size-3.5" />}
        value={card.repeat ? describeRepeat(card.repeat) : 'Off'}
        width={260}
      >
        <RepeatPicker card={card} apply={apply} close={close} />
      </SubMenu>
      <SubMenu
        id="priority"
        label="Priority"
        icon={<Flag className="size-3.5" />}
        value={card.priority ? priorityLabel(card.priority) : 'None'}
        width={200}
      >
        <PriorityPicker card={card} apply={apply} close={close} />
      </SubMenu>
      <SubMenu
        id="cover"
        label="Cover"
        icon={<ImageIcon className="size-3.5" />}
        value={card.coverAttachmentId ? 'On' : 'None'}
      >
        <MenuItem onClick={() => void setCoverFromFile()}>
          <Row icon={<FileImage className="size-3.5" />}>Set from file…</Row>
        </MenuItem>
        <MenuItem
          onClick={() => {
            onRequestCoverFromUrl()
            close()
          }}
        >
          <Row icon={<Globe className="size-3.5" />}>Set from URL…</Row>
        </MenuItem>
        {card.coverAttachmentId && (
          <MenuItem onClick={removeCover}>
            <Row icon={<ImageOff className="size-3.5" />}>Remove cover</Row>
          </MenuItem>
        )}
      </SubMenu>

      <MenuSep />
      {onToggleCollapse && (
        <MenuItem
          onClick={() => {
            onToggleCollapse()
            close()
          }}
        >
          <Row
            icon={
              compact ? (
                <ChevronsUpDown className="size-3.5" />
              ) : (
                <ChevronsDownUp className="size-3.5" />
              )
            }
          >
            {compact ? 'Expand card' : 'Collapse card'}
          </Row>
        </MenuItem>
      )}
      <MenuItem
        onClick={() => {
          apply(
            {
              type: 'card.update',
              id: card.id,
              patch: { completed: !card.completed }
            },
            (b) => mapCard(b, card.id, (c) => ({ ...c, completed: !c.completed }))
          )
          close()
        }}
      >
        <Row icon={<CheckSquare className="size-3.5" />}>
          {card.completed ? 'Mark incomplete' : 'Mark complete'}
        </Row>
      </MenuItem>
      {/* Off the board but kept: the board's Archived view brings it
          back. Undoable like any edit. */}
      <MenuItem
        onClick={() => {
          apply(
            { type: 'card.update', id: card.id, patch: { archived: true } },
            (b) => dropCard(b, card.id)
          )
          close()
        }}
      >
        <Row icon={<Archive className="size-3.5" />}>Archive card</Row>
      </MenuItem>
      <MenuItem
        danger
        onClick={() => {
          apply({ type: 'card.delete', id: card.id }, (b) =>
            dropCard(b, card.id)
          )
          close()
        }}
      >
        <Row icon={<Trash2 className="size-3.5" />}>Delete card</Row>
      </MenuItem>
    </>
  )
}
