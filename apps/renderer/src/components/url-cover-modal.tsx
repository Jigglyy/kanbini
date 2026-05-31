import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Globe } from 'lucide-react'
import type { CardView } from '@kanbini/shared'
import { ipc } from '../lib/ipc'
import { useSettings } from '../lib/settings'
import { Button } from './ui/button'
import { Modal } from './ui/modal'

// "Set cover from URL…" modal. The only path in the app that hits
// the network (ADR-0023). If linkPreviews is off, the modal shows a
// consent panel first - the user has to flip the toggle (inline,
// without leaving the dialog) before they can submit.

export function UrlCoverModal({
  card,
  open,
  onClose
}: {
  card: CardView
  open: boolean
  onClose: () => void
}) {
  const [settings, updateSettings] = useSettings()
  const [url, setUrl] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) return
    setUrl('')
    setError(null)
    queueMicrotask(() => inputRef.current?.focus())
  }, [open])

  async function submit(): Promise<void> {
    const trimmed = url.trim()
    if (!trimmed || submitting || !settings.linkPreviews) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await ipc.linkPreviewCreate({
        cardId: card.id,
        url: trimmed
      })
      if (!result.ok) {
        // Expected misses (no preview image, 404, content-type
        // rejected, …) come back as `{ok:false}` from the IPC layer
        // so they don't log like a crash. Surface the message here.
        setError(result.error || 'Could not fetch preview.')
        return
      }
      // Main applies card.update.coverAttachmentId atomically + fires
      // broadcastChange; the renderer's listener picks the new cover
      // up automatically. No further work here.
      onClose()
    } catch (e) {
      // Unexpected failures only (zod parse errors, preload missing,
      // IPC transport blew up). The "no image" path no longer throws.
      setError(e instanceof Error ? e.message : 'Could not fetch preview.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} label="Set cover from URL">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        className="flex flex-col gap-4 p-6"
      >
        <header className="flex items-center gap-2">
          <Globe className="size-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Set cover from URL</h2>
        </header>

        {!settings.linkPreviews && (
          <ConsentPanel
            onEnable={() => updateSettings({ linkPreviews: true })}
          />
        )}

        <label className="flex flex-col gap-1 text-sm">
          <span>URL</span>
          <input
            ref={inputRef}
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/article"
            maxLength={2048}
            required
            disabled={!settings.linkPreviews || submitting}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          />
          <span className="text-xs text-muted-foreground">
            Kanbini fetches the page's preview image (Open Graph or
            Twitter card) and saves it locally as the card's cover.
          </span>
        </label>

        {error && (
          <p className="rounded-md border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">
            {error}
          </p>
        )}

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={
              !settings.linkPreviews || !url.trim() || submitting
            }
          >
            {submitting ? 'Fetching…' : 'Fetch preview'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function ConsentPanel({ onEnable }: { onEnable: () => void }) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/10 p-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="flex flex-col gap-1 text-xs text-foreground">
          <span className="font-medium">Link previews are off.</span>
          <span>
            Turn this on to let Kanbini grab a preview image from the
            URL you paste. The image is saved on your computer
            afterwards. You can switch it back off anytime in Settings.
          </span>
        </div>
      </div>
      <div>
        <Button type="button" size="sm" onClick={onEnable}>
          Enable link previews
        </Button>
      </div>
    </div>
  )
}
