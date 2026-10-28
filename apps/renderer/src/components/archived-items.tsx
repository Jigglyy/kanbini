import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, RotateCcw, Trash2, X } from 'lucide-react'
import type { Mutation } from '@kanbini/shared'
import { boardsRootKey } from '../hooks/useBoard'
import { boardsListKey } from '../hooks/useBoardsList'
import { ipc } from '../lib/ipc'
import { Modal } from './ui/modal'

// The board's Archived view (opened from the board's pencil menu):
// archived cards and closed lists, which the board, search and the home
// counts all hide. Each can be restored or deleted (Delete asks first;
// both are undoable with Ctrl+Z like any edit). Restoring a card whose
// list is closed too reopens the list in the same change - otherwise the
// card would come back into a list you still can't see.

/** Cache slot under the board's prefix, so every change event (an edit
 *  here, the AI archiving something) refreshes it with the board. */
export const archivedKey = (boardId: string) => ['board', boardId, 'archived'] as const

export function ArchivedItemsDialog({
  open,
  boardId,
  boardName,
  onClose
}: {
  open: boolean
  boardId: string
  boardName: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const { data, status } = useQuery({
    queryKey: archivedKey(boardId),
    queryFn: () => ipc.archivedItems({ boardId }),
    enabled: open
  })

  const run = (m: Mutation | Mutation[]): void => {
    const done = Array.isArray(m) ? ipc.mutateBatch(m) : ipc.mutate(m)
    done
      .then(() =>
        Promise.all([
          qc.invalidateQueries({ queryKey: boardsRootKey }),
          qc.invalidateQueries({ queryKey: boardsListKey })
        ])
      )
      .catch((e) => console.warn('archived item action failed:', e))
  }

  const cards = data?.cards ?? []
  const lists = data?.lists ?? []
  const empty = status === 'success' && cards.length === 0 && lists.length === 0

  return (
    <Modal open={open} onClose={onClose} label={`Archived on ${boardName}`}>
      <div className="flex flex-col gap-4 p-5">
        <header className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Archive className="size-4 text-muted-foreground" aria-hidden />
            Archived
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </header>

        {empty && (
          <p className="text-sm text-muted-foreground">
            Nothing is archived on this board. Archive a card from its
            right-click menu to put it away without deleting it.
          </p>
        )}

        {cards.length > 0 && (
          <Section title={`Cards (${cards.length})`}>
            {cards.map((c) => (
              <ItemRow
                key={c.id}
                name={c.title}
                detail={
                  <>
                    in {c.listName}
                    {c.listClosed && ' (archived too)'}
                  </>
                }
                confirmText={`Delete “${c.title}”? You can undo this with Ctrl+Z.`}
                onRestore={() =>
                  run(
                    c.listClosed
                      ? [
                          { type: 'list.update', id: c.listId, patch: { closed: false } },
                          { type: 'card.update', id: c.id, patch: { archived: false } }
                        ]
                      : { type: 'card.update', id: c.id, patch: { archived: false } }
                  )
                }
                onDelete={() => run({ type: 'card.delete', id: c.id })}
              />
            ))}
          </Section>
        )}

        {lists.length > 0 && (
          <Section title={`Lists (${lists.length})`}>
            {lists.map((l) => (
              <ItemRow
                key={l.id}
                name={l.name}
                color={l.color}
                detail={`${l.cardCount} card${l.cardCount === 1 ? '' : 's'}`}
                confirmText={`Delete “${l.name}” and its ${l.cardCount} card${
                  l.cardCount === 1 ? '' : 's'
                }? You can undo this with Ctrl+Z.`}
                onRestore={() =>
                  run({ type: 'list.update', id: l.id, patch: { closed: false } })
                }
                onDelete={() => run({ type: 'list.delete', id: l.id })}
              />
            ))}
          </Section>
        )}
      </div>
    </Modal>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
        {children}
      </ul>
    </section>
  )
}

/** One archived card or list: name + where/how big, Restore, Delete
 *  (with an inline confirm, like the menus' delete rows). */
function ItemRow({
  name,
  color,
  detail,
  confirmText,
  onRestore,
  onDelete
}: {
  name: string
  color?: string | null
  detail: React.ReactNode
  confirmText: string
  onRestore: () => void
  onDelete: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  return (
    <li aria-label={name} className="flex flex-col gap-2 px-3 py-2">
      <div className="flex items-center gap-3">
        {color && (
          <span
            aria-hidden
            className="size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: color }}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium wrap-anywhere">{name}</div>
          <div className="truncate text-xs text-muted-foreground">{detail}</div>
        </div>
        {!confirming && (
          <>
            <button
              type="button"
              onClick={onRestore}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-foreground hover:bg-muted"
            >
              <RotateCcw className="size-3.5" aria-hidden />
              Restore
            </button>
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-red-400 hover:bg-muted hover:text-red-300"
            >
              <Trash2 className="size-3.5" aria-hidden />
              Delete
            </button>
          </>
        )}
      </div>
      {confirming && (
        <div className="flex items-center gap-2">
          <span className="flex-1 text-xs text-muted-foreground">{confirmText}</span>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirming(false)
              onDelete()
            }}
            className="rounded-md bg-red-500/90 px-2 py-1 text-xs text-white hover:bg-red-500"
          >
            Delete
          </button>
        </div>
      )}
    </li>
  )
}
