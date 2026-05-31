import { useEffect, useState } from 'react'
import { BookmarkPlus, Image as ImageIcon, Pencil, Rows3 } from 'lucide-react'
import type {
  BoardView,
  Mutation,
  SwimlaneMode
} from '@kanbini/shared'
import type { Optimistic } from '../hooks/useBoardMutation'
import { BackgroundPicker } from './background-picker'
import { SaveTemplateDialog } from './templates'
import { Popover } from './ui/popover'
import { Tooltip } from './ui/tooltip'

// Inline board-rename trigger: a pencil button next to the board
// name in the header. Opens a one-field popover with just the name
// input - everything else this popover used to hold (Backup /
// Restore) moved to Settings → Data in M4-F, so the surface here
// stays single-purpose. ADR-0034 added a "Background…" row that
// opens the picker modal (same one the boards-home context menu
// uses) so changing the wallpaper doesn't require going back to home.

type Apply = (m: Mutation, o: Optimistic) => void

export function BoardSettings({
  board,
  apply
}: {
  board: BoardView
  apply: Apply
}) {
  const [bgOpen, setBgOpen] = useState(false)
  const [saveTplOpen, setSaveTplOpen] = useState(false)
  return (
    <>
      <Popover
        width={224}
        trigger={({ toggle }) => (
          <Tooltip label="Rename board" side="bottom">
            <button
              type="button"
              aria-label="Rename board"
              onClick={toggle}
              className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Pencil className="size-3.5" />
            </button>
          </Tooltip>
        )}
      >
        {(close) => (
          <RenameBody
            board={board}
            apply={apply}
            close={close}
            onOpenBackground={() => {
              close()
              setBgOpen(true)
            }}
            onSaveAsTemplate={() => {
              close()
              setSaveTplOpen(true)
            }}
          />
        )}
      </Popover>
      {bgOpen && (
        <BackgroundPicker
          open
          boardId={board.board.id}
          value={board.board.background}
          apply={(m) =>
            apply(m, (b) => ({
              ...b,
              board: { ...b.board, background: m.patch.background ?? null }
            }))
          }
          onClose={() => setBgOpen(false)}
        />
      )}
      <SaveTemplateDialog
        open={saveTplOpen}
        kind="board"
        sourceId={board.board.id}
        defaultName={board.board.name}
        onClose={() => setSaveTplOpen(false)}
      />
    </>
  )
}

function RenameBody({
  board,
  apply,
  close,
  onOpenBackground,
  onSaveAsTemplate
}: {
  board: BoardView
  apply: Apply
  close: () => void
  onOpenBackground: () => void
  onSaveAsTemplate: () => void
}) {
  const [name, setName] = useState(board.board.name)
  // Re-sync if the board is renamed elsewhere while this popover is
  // open, so a stale buffer can't revert that change on blur.
  useEffect(() => setName(board.board.name), [board.board.name])

  const rename = (): void => {
    const n = name.trim()
    if (!n || n === board.board.name) return
    apply(
      { type: 'board.update', id: board.board.id, patch: { name: n } },
      (b) => ({ ...b, board: { ...b.board, name: n } })
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Board name
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              rename()
              close()
            }
          }}
          onBlur={rename}
          className="rounded border border-border bg-background px-2 py-1 text-sm text-foreground focus:border-ring focus:outline-none"
        />
      </label>
      <button
        type="button"
        onClick={onOpenBackground}
        className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-foreground hover:bg-muted"
      >
        <ImageIcon className="size-3.5 text-muted-foreground" />
        Background…
      </button>
      <button
        type="button"
        onClick={onSaveAsTemplate}
        className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-foreground hover:bg-muted"
      >
        <BookmarkPlus className="size-3.5 text-muted-foreground" />
        Save as template…
      </button>
      <SwimlaneRow board={board} apply={apply} />
    </div>
  )
}

/** ADR-0037 slice 2 toolbar control: pick the swimlane grouping
 *  axis. None / Priority for v1; the schema reserves room for
 *  label-based modes later. Apply optimistically so the layout re-
 *  flows the moment the user clicks. */
function SwimlaneRow({ board, apply }: { board: BoardView; apply: Apply }) {
  const current = board.board.swimlaneMode
  const set = (next: SwimlaneMode | null): void => {
    if (next === current) return
    apply(
      {
        type: 'board.update',
        id: board.board.id,
        patch: { swimlaneMode: next }
      },
      (b) => ({
        ...b,
        board: { ...b.board, swimlaneMode: next }
      })
    )
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 px-2 pt-1 text-xs text-muted-foreground">
        <Rows3 className="size-3.5" />
        Group by
      </div>
      <div className="flex gap-1 px-2">
        <SwimlaneChip active={current == null} onClick={() => set(null)}>
          None
        </SwimlaneChip>
        <SwimlaneChip
          active={current === 'priority'}
          onClick={() => set('priority')}
        >
          Priority
        </SwimlaneChip>
      </div>
    </div>
  )
}

function SwimlaneChip({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2 py-1 text-xs ${
        active
          ? 'bg-primary text-primary-foreground'
          : 'text-foreground hover:bg-muted'
      }`}
    >
      {children}
    </button>
  )
}
