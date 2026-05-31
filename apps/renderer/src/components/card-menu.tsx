import { FileImage, Globe, ImageOff } from 'lucide-react'
import type { BoardView, CardView, LabelView, Mutation } from '@kanbini/shared'
import type { Optimistic } from '../hooks/useBoardMutation'
import { ipc } from '../lib/ipc'
import { LabelToggleList } from './labels'
import { DueEditor } from './due-date'
import { PriorityPicker } from './priority'
import { MenuItem, MenuLabel, MenuSep } from './ui/context-menu'

// Content of a card's right-click menu: labels + due + cover + complete
// + delete in one place (replaces the misclick-prone hover buttons).

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

export function CardMenu({
  card,
  labels,
  apply,
  close,
  onRequestCoverFromUrl
}: {
  card: CardView
  labels: LabelView[]
  apply: Apply
  close: () => void
  /** Lifted to the parent (SortableCard) so the URL modal survives
   *  this menu closing - ContextMenu unmounts its panel on close. */
  onRequestCoverFromUrl: () => void
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

  return (
    <>
      <MenuLabel>Labels</MenuLabel>
      <LabelToggleList card={card} labels={labels} apply={apply} />

      <MenuSep />
      <MenuLabel>Due date</MenuLabel>
      <DueEditor card={card} apply={apply} close={close} />

      <MenuSep />
      <PriorityPicker card={card} apply={apply} close={close} />

      <MenuSep />
      <MenuLabel>Cover</MenuLabel>
      <MenuItem onClick={() => void setCoverFromFile()}>
        <span className="inline-flex items-center gap-2">
          <FileImage className="size-3.5" /> Set from file…
        </span>
      </MenuItem>
      <MenuItem
        onClick={() => {
          onRequestCoverFromUrl()
          close()
        }}
      >
        <span className="inline-flex items-center gap-2">
          <Globe className="size-3.5" /> Set from URL…
        </span>
      </MenuItem>
      {card.coverAttachmentId && (
        <MenuItem onClick={removeCover}>
          <span className="inline-flex items-center gap-2">
            <ImageOff className="size-3.5" /> Remove cover
          </span>
        </MenuItem>
      )}

      <MenuSep />
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
        {card.completed ? 'Mark incomplete' : 'Mark complete'}
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
        Delete card
      </MenuItem>
    </>
  )
}
