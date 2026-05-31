import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  TemplateInstantiateRequest,
  TemplateKind,
  TemplateSaveRequest,
  TemplateSummary
} from '@kanbini/shared'
import { boardsRootKey } from '../hooks/useBoard'
import { boardsListKey } from '../hooks/useBoardsList'
import { ipc } from '../lib/ipc'
import { Button } from './ui/button'
import { Modal } from './ui/modal'

// ADR-0038 template UIs. One file holds every surface - they all talk
// to the same tiny IPC, so co-locating them keeps imports tidy and
// makes the manager / picker / save dialog easy to evolve together.

const templatesKey = ['templates'] as const

/** TanStack hook so manager + picker + post-save invalidation all
 *  observe the same canonical list. Backed by `template:list`. */
function useTemplates() {
  return useQuery({
    queryKey: templatesKey,
    queryFn: () => ipc.templateList(),
    staleTime: 5_000
  })
}

// ---- Save flow ------------------------------------------------------

/** Asks for a name (pre-filled from the source entity), then saves a
 *  board or list as a template via IPC. Resolves via onSaved + closes. */
export function SaveTemplateDialog({
  open,
  kind,
  sourceId,
  defaultName,
  onClose,
  onSaved
}: {
  open: boolean
  kind: TemplateKind
  sourceId: string
  defaultName: string
  onClose: () => void
  onSaved?: () => void
}) {
  const [name, setName] = useState(defaultName)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const qc = useQueryClient()

  // Reset state whenever the dialog re-opens (e.g. user saves one
  // template, then opens another from the same board). Focus is
  // handled by the input's `autoFocus`, which fires on mount - and
  // the Modal only mounts its children when `open` flips to true.
  useEffect(() => {
    if (!open) return
    setName(defaultName)
    setError(null)
    setSubmitting(false)
  }, [open, defaultName])

  const submit = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) return
    setSubmitting(true)
    setError(null)
    try {
      const req: TemplateSaveRequest =
        kind === 'board'
          ? { kind: 'board', sourceId, name: trimmed }
          : { kind: 'list', sourceId, name: trimmed }
      await ipc.templateSave(req)
      await qc.invalidateQueries({ queryKey: templatesKey })
      onSaved?.()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the template.')
      setSubmitting(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} label="Save as template">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        className="flex flex-col gap-4 p-6"
      >
        <h2 className="text-lg font-semibold">
          Save {kind === 'board' ? 'board' : 'list'} as template
        </h2>
        <p className="text-sm text-muted-foreground">
          Captures the {kind === 'board' ? 'lists, labels' : 'cards'} and card
          content (title, description, priority, checklists
          {kind === 'board' ? ', label assignments' : ''}). Excludes
          comments, attachments, due dates, and activity history.
        </p>
        <label className="flex flex-col gap-1 text-sm">
          <span>Template name</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            required
            disabled={submitting}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
            {submitting ? 'Saving…' : 'Save template'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

// ---- Instantiate (picker) -------------------------------------------

/** Pick one of the saved templates, then instantiate it. Filters the
 *  list by kind so a list-template picker doesn't surface board
 *  templates and vice versa. */
export function TemplatePickerDialog({
  open,
  kind,
  targetBoardId,
  onClose,
  onCreated
}: {
  open: boolean
  kind: TemplateKind
  /** Required for kind='list' (the board the new list lands on);
   *  ignored for kind='board' (a fresh board is created). */
  targetBoardId?: string
  onClose: () => void
  /** Called with the new board id (board template) or with the new
   *  list's board id (list template) so the host can navigate /
   *  refetch. */
  onCreated: (result: { boardId: string; listId: string | null }) => void
}) {
  const { data: templates, isLoading } = useTemplates()
  const [submittingId, setSubmittingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const qc = useQueryClient()
  const filtered = useMemo(
    () => (templates ?? []).filter((t) => t.kind === kind),
    [templates, kind]
  )

  useEffect(() => {
    if (open) setError(null)
  }, [open])

  const pick = async (t: TemplateSummary): Promise<void> => {
    if (kind === 'list' && !targetBoardId) {
      setError("Couldn't determine which board to add the list to.")
      return
    }
    setSubmittingId(t.id)
    setError(null)
    try {
      const req: TemplateInstantiateRequest =
        kind === 'board'
          ? { kind: 'board', templateId: t.id }
          : { kind: 'list', templateId: t.id, targetBoardId: targetBoardId! }
      const result = await ipc.templateInstantiate(req)
      await Promise.all([
        qc.invalidateQueries({ queryKey: boardsListKey }),
        qc.invalidateQueries({ queryKey: boardsRootKey })
      ])
      onCreated({ boardId: result.boardId, listId: result.listId })
      onClose()
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Could not use the template.'
      )
      setSubmittingId(null)
    }
  }

  const title =
    kind === 'board' ? 'New board from template' : 'Add list from template'
  const empty =
    kind === 'board'
      ? "You haven't saved a board template yet. From a board, open the rename popover and pick “Save as template…”."
      : "You haven't saved a list template yet. From a list, open its menu and pick “Save as template…”."

  return (
    <Modal open={open} onClose={onClose} label={title}>
      <div className="flex flex-col gap-4 p-6">
        <h2 className="text-lg font-semibold">{title}</h2>
        {isLoading && (
          <p className="text-sm text-muted-foreground">Loading templates…</p>
        )}
        {!isLoading && filtered.length === 0 && (
          <p className="text-sm text-muted-foreground">{empty}</p>
        )}
        {filtered.length > 0 && (
          <ul className="flex max-h-[60vh] flex-col gap-1 overflow-y-auto">
            {filtered.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => void pick(t)}
                  disabled={submittingId !== null}
                  className="flex w-full items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2 text-left hover:border-ring hover:bg-muted disabled:opacity-60"
                >
                  <span className="flex-1 min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {t.name}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {countsLabel(t)}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {submittingId === t.id ? 'Creating…' : 'Use'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={submittingId !== null}
          >
            Close
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function countsLabel(t: TemplateSummary): string {
  if (t.kind === 'board') {
    const lists = `${t.listCount} ${t.listCount === 1 ? 'list' : 'lists'}`
    const cards = `${t.cardCount} ${t.cardCount === 1 ? 'card' : 'cards'}`
    return `Board · ${lists} · ${cards}`
  }
  const cards = `${t.cardCount} ${t.cardCount === 1 ? 'card' : 'cards'}`
  return `List · ${cards}`
}

// ---- Settings → Templates manager -----------------------------------

/** Rendered as a section of Settings → Templates. Lists every saved
 *  template grouped by kind; supports inline rename and delete-with-
 *  confirm. Saving + using templates lives in the existing surfaces
 *  (rename popover, boards-home, AddList) - the manager is the
 *  long-form housekeeping home. */
export function TemplatesManager() {
  const { data: templates, isLoading } = useTemplates()
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
    null
  )
  // Escape on the rename input should ABORT, but the input is removed
  // from the DOM by the same state update - Chromium fires `blur` on
  // the just-removed focused element, which would otherwise re-trigger
  // commitRename with the typed value (the typed value is closed over
  // from the keydown render). Flip this ref before unmount so the
  // blur handler bails. Same pattern useful any time you have
  // commit-on-blur + cancel-on-escape on the same field.
  const skipBlurRef = useRef(false)
  const qc = useQueryClient()

  const refresh = (): Promise<unknown> =>
    qc.invalidateQueries({ queryKey: templatesKey })

  const startRename = (t: TemplateSummary): void => {
    setRenamingId(t.id)
    setRenameValue(t.name)
  }
  const cancelRename = (): void => {
    skipBlurRef.current = true
    setRenamingId(null)
  }
  const commitRename = async (t: TemplateSummary): Promise<void> => {
    if (skipBlurRef.current) {
      skipBlurRef.current = false
      setRenamingId(null)
      return
    }
    const next = renameValue.trim()
    setRenamingId(null)
    if (!next || next === t.name) return
    await ipc.templateRename({ id: t.id, name: next })
    await refresh()
  }
  const doDelete = async (id: string): Promise<void> => {
    setConfirmingDeleteId(null)
    await ipc.templateDelete({ id })
    await refresh()
  }

  if (isLoading) {
    return (
      <p className="text-sm text-muted-foreground">Loading templates…</p>
    )
  }
  if (!templates || templates.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No templates saved yet. Open a board (or a list) and pick{' '}
        <em>Save as template…</em> from its menu.
      </p>
    )
  }

  return (
    <ul className="flex flex-col gap-1.5">
      {templates.map((t) => (
        <li
          key={t.id}
          className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2"
        >
          {renamingId === t.id ? (
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitRename(t)
                else if (e.key === 'Escape') cancelRename()
              }}
              onBlur={() => void commitRename(t)}
              maxLength={200}
              className="flex-1 rounded border border-border bg-background px-2 py-1 text-sm focus:border-ring focus:outline-none"
            />
          ) : (
            <span className="flex flex-1 flex-col min-w-0">
              <span className="truncate text-sm font-medium">{t.name}</span>
              <span className="text-xs text-muted-foreground">
                {countsLabel(t)}
              </span>
            </span>
          )}
          {confirmingDeleteId === t.id ? (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setConfirmingDeleteId(null)}
                className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void doDelete(t.id)}
                className="rounded bg-red-500/90 px-2 py-1 text-xs text-white hover:bg-red-500"
              >
                Delete
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => startRename(t)}
                className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                Rename
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDeleteId(t.id)}
                className="rounded px-2 py-1 text-xs text-red-400 hover:bg-muted hover:text-red-300"
              >
                Delete
              </button>
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}
