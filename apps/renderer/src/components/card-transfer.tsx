import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { Mutation } from '@kanbini/shared'
import { useBoard } from '../hooks/useBoard'
import { useBoardsList } from '../hooks/useBoardsList'
import { ipc } from '../lib/ipc'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { Modal } from './ui/modal'

// Move or copy cards to any list of any board. The card menu's "Move…" /
// "Copy…" and the multi-select menu's "Move…" open this dialog; "Duplicate"
// skips it (a copy right below the card). Labels travel by name and the
// server creates any the target board is missing (card-copy.ts in
// @kanbini/db), so the dialog doesn't need to say anything about them.

export type TransferMode = 'move' | 'copy'

/** What a card's menu can ask its board to do. Provided by Board through
 *  context (so the memoised cards don't take another prop); absent in
 *  hosts without a board, where the menu leaves these items out. */
export interface CardActions {
  duplicate: (cardId: string) => void
  transfer: (mode: TransferMode, cardIds: string[]) => void
}

export const CardActionsContext = createContext<CardActions | null>(null)

export const useCardActions = (): CardActions | null => useContext(CardActionsContext)

type Placement = 'top' | 'bottom'

/** The mutations that put `cardIds` (in board order) into `toListId`:
 *  as a block at the top or bottom of the list, order kept. Pure so the
 *  placement maths is unit-tested. `listCardIds` is the target list's
 *  current order. A copy only ever carries one card. */
export function transferMutations(opts: {
  mode: TransferMode
  cardIds: string[]
  toListId: string
  listCardIds: string[]
  placement: Placement
  title?: string
}): Mutation[] {
  const { mode, cardIds, toListId, listCardIds, placement } = opts
  const moving = new Set(cardIds)
  const firstOther = listCardIds.find((id) => !moving.has(id)) ?? null
  return cardIds.map((id, i) => {
    // Top: the first card goes above the list's first other card, each
    // next one right under the previous. Bottom: no neighbours = the end,
    // so appending in order keeps the order.
    const at =
      placement === 'top'
        ? i === 0
          ? { afterId: firstOther }
          : { beforeId: cardIds[i - 1]! }
        : {}
    return mode === 'copy'
      ? { type: 'card.copy', id, toListId, ...at, ...(opts.title ? { title: opts.title } : {}) }
      : { type: 'card.move', id, toListId, ...at }
  })
}

export function CardTransferDialog({
  mode,
  cardIds,
  sourceBoardId,
  sourceListId,
  sourceTitle,
  onClose,
  onDone,
  onOpenCard
}: {
  mode: TransferMode
  /** In board order. */
  cardIds: string[]
  sourceBoardId: string
  /** The list the (first) card is in - the default target on this board. */
  sourceListId: string | null
  /** The card's title, for a single-card copy (editable). */
  sourceTitle?: string
  onClose: () => void
  /** After a successful move / copy (the host clears its selection). */
  onDone?: () => void
  /** "Open card" after a move / copy to another board. */
  onOpenCard?: (boardId: string, cardId: string) => void
}) {
  const boards = useBoardsList()
  const [boardId, setBoardId] = useState(sourceBoardId)
  const target = useBoard(boardId)
  const lists = useMemo(
    () => (target.data?.lists ?? []).filter((l) => !l.closed),
    [target.data]
  )
  const [listId, setListId] = useState<string | null>(sourceListId)
  const [placement, setPlacement] = useState<Placement>('bottom')
  const [title, setTitle] = useState(sourceTitle ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [landed, setLanded] = useState<{ boardId: string; cardId: string } | null>(null)

  // Keep the list pick valid for the chosen board: the card's own list on
  // its board, else the board's first list.
  useEffect(() => {
    if (lists.length === 0) return
    if (listId && lists.some((l) => l.id === listId)) return
    const own = boardId === sourceBoardId ? lists.find((l) => l.id === sourceListId) : undefined
    setListId((own ?? lists[0]!).id)
  }, [lists, listId, boardId, sourceBoardId, sourceListId])

  const targetList = lists.find((l) => l.id === listId) ?? null
  const many = cardIds.length > 1
  const noun = many ? `${cardIds.length} cards` : 'card'
  const verb = mode === 'move' ? 'Move' : 'Copy'
  const boardOptions = (boards.data ?? []).filter((b) => !b.archived || b.id === sourceBoardId)
  const boardName = boardOptions.find((b) => b.id === boardId)?.name ?? ''
  const copyTitle = title.trim()
  const canSubmit =
    !busy && targetList !== null && !(mode === 'copy' && !many && copyTitle === '')

  const submit = async (): Promise<void> => {
    if (!targetList || !canSubmit) return
    setBusy(true)
    setError(null)
    try {
      const ms = transferMutations({
        mode,
        cardIds,
        toListId: targetList.id,
        listCardIds: targetList.cards.map((c) => c.id),
        placement,
        title:
          mode === 'copy' && !many && copyTitle !== sourceTitle ? copyTitle : undefined
      })
      const results = ms.length === 1 ? [await ipc.mutate(ms[0]!)] : await ipc.mutateBatch(ms)
      onDone?.()
      if (boardId === sourceBoardId) {
        onClose()
        return
      }
      setLanded({ boardId, cardId: results[0]!.id })
      setBusy(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : `Could not ${verb.toLowerCase()} the ${noun}.`)
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} label={`${verb} ${noun}`}>
      {landed ? (
        <div className="flex flex-col gap-4 p-6">
          <h2 className="text-lg font-semibold">
            {mode === 'move' ? 'Moved' : 'Copied'} to {boardName}
          </h2>
          <p className="text-sm text-muted-foreground">
            {many ? `The ${noun} are` : 'It’s'} in{' '}
            <strong className="text-foreground">{targetList?.name}</strong>. Ctrl+Z on
            this board takes {mode === 'move' ? 'the move' : 'the copy'} back.
          </p>
          <div className="flex items-center justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Done
            </Button>
            {onOpenCard && (
              <Button
                type="button"
                onClick={() => {
                  onClose()
                  onOpenCard(landed.boardId, landed.cardId)
                }}
              >
                Open {many ? 'first card' : 'card'}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
          className="flex flex-col gap-4 p-6"
        >
          <h2 className="text-lg font-semibold">
            {verb} {noun}
          </h2>
          {mode === 'copy' && !many && (
            <label className="flex flex-col gap-1 text-sm">
              <span>Title</span>
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={500}
                disabled={busy}
                className="rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
          )}
          <label className="flex flex-col gap-1 text-sm">
            <span>Board</span>
            <select
              value={boardId}
              onChange={(e) => {
                setBoardId(e.target.value)
                setListId(null)
              }}
              disabled={busy}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {boardOptions.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                  {b.id === sourceBoardId ? ' (this board)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>List</span>
            <select
              value={listId ?? ''}
              onChange={(e) => setListId(e.target.value)}
              disabled={busy || lists.length === 0}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          {target.data && lists.length === 0 && (
            <p className="text-sm text-muted-foreground">
              That board has no lists yet. Add one there first.
            </p>
          )}
          <fieldset className="flex flex-col gap-1 text-sm" disabled={busy}>
            <legend className="mb-1">Position</legend>
            {targetList?.sortMode ? (
              <p className="text-muted-foreground">
                This list sorts its cards, so {many ? 'they go' : 'it goes'} where the sort
                puts {many ? 'them' : 'it'}.
              </p>
            ) : (
              <div className="flex gap-2" role="radiogroup" aria-label="Position">
                {(['top', 'bottom'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={placement === p}
                    onClick={() => setPlacement(p)}
                    className={cn(
                      'rounded-md border px-3 py-1.5 text-sm',
                      placement === p
                        ? 'border-primary bg-primary/15 text-foreground'
                        : 'border-input text-muted-foreground hover:bg-muted hover:text-foreground'
                    )}
                  >
                    {p === 'top' ? 'Top of the list' : 'Bottom of the list'}
                  </button>
                ))}
              </div>
            )}
          </fieldset>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex items-center justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {busy ? `${verb === 'Move' ? 'Moving' : 'Copying'}…` : verb}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  )
}
