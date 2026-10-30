import { useState } from 'react'
import { FolderOpen } from 'lucide-react'
import type { BoardExportResult, BoardFileContent } from '@kanbini/shared'
import { ipc } from '../lib/ipc'
import { cn } from '../lib/utils'
import { humanSize } from './attachments'
import { Button } from './ui/button'
import { Modal } from './ui/modal'

// Export one board to a `.kanbini` file (main's board:export picks where
// to save, @kanbini/db board-file.ts writes it). Two choices: just the
// lists (the board's set-up, to start a new board from) or the lists and
// every card. The boards home's Import board brings either back as a new
// board. Opened from the board's pencil menu and from a board's
// right-click menu on the boards home.

const CHOICES: { value: BoardFileContent; title: string; detail: string }[] = [
  {
    value: 'lists',
    title: 'Just the lists',
    detail:
      'The lists and their settings, the labels, and how the board looks. No cards, so it’s a clean start for a new board.'
  },
  {
    value: 'cards',
    title: 'Lists and all cards',
    detail:
      'Everything on the board: every card with its description, labels, checklists, dates, comments, attachments and history.'
  }
]

/** The file's name and the folder it's in, split for display. */
export function splitPath(path: string): { name: string; folder: string } {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at < 0 ? { name: path, folder: '' } : { name: path.slice(at + 1), folder: path.slice(0, at) }
}

export function BoardExportDialog({
  boardId,
  boardName,
  onClose
}: {
  boardId: string
  boardName: string
  onClose: () => void
}) {
  const [content, setContent] = useState<BoardFileContent>('cards')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<BoardExportResult | null>(null)

  const run = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await ipc.boardExport({ boardId, content })
      if (result) setSaved(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not export the board.')
    } finally {
      setBusy(false)
    }
  }

  if (saved) {
    const { name, folder } = splitPath(saved.path)
    return (
      <Modal open onClose={onClose} label="Board exported">
        <div className="flex flex-col gap-4 p-6">
          <h2 className="text-lg font-semibold">Exported “{boardName}”</h2>
          <p className="text-sm text-muted-foreground">
            Saved as <strong className="text-foreground">{name}</strong> ({humanSize(saved.bytes)})
            {folder && (
              <>
                {' '}in{' '}
                <code className="rounded bg-muted px-1 py-0.5 text-xs text-foreground/90 [overflow-wrap:anywhere]">
                  {folder}
                </code>
              </>
            )}
            . To open it in Kanbini, use Import board on the boards home.
          </p>
          {saved.skippedAttachments > 0 && (
            <p className="text-sm text-warning">
              {saved.skippedAttachments === 1
                ? '1 attachment is missing from this computer, so it isn’t in the file.'
                : `${saved.skippedAttachments} attachments are missing from this computer, so they aren’t in the file.`}
            </p>
          )}
          <div className="flex items-center justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => void ipc.showInFolder({ path: saved.path })}
            >
              <FolderOpen className="size-4" />
              Show in folder
            </Button>
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal open onClose={onClose} label="Export board">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void run()
        }}
        className="flex flex-col gap-4 p-6"
      >
        <h2 className="text-lg font-semibold">Export “{boardName}”</h2>
        <fieldset className="flex flex-col gap-2" disabled={busy}>
          <legend className="mb-2 text-sm text-muted-foreground">What should the file hold?</legend>
          {CHOICES.map((c) => (
            <label
              key={c.value}
              className={cn(
                'flex cursor-pointer gap-3 rounded-md border p-3 text-sm',
                content === c.value
                  ? 'border-primary bg-primary/10'
                  : 'border-input hover:bg-muted'
              )}
            >
              <input
                type="radio"
                name="board-export-content"
                value={c.value}
                checked={content === c.value}
                onChange={() => setContent(c.value)}
                className="mt-0.5 accent-primary"
              />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium text-foreground">{c.title}</span>
                <span className="text-muted-foreground">{c.detail}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? 'Exporting…' : 'Export…'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
