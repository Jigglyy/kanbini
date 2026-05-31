import { useState } from 'react'
import { File as FileIcon, FileImage, Globe, ImageOff, X } from 'lucide-react'
import {
  decodeHtmlEntities,
  type AttachmentView,
  type BoardView,
  type CardView,
  type Mutation
} from '@kanbini/shared'
import type { Optimistic } from '../hooks/useBoardMutation'
import { ipc } from '../lib/ipc'
import { domainOf } from '../lib/url'
import { ImageLightbox } from './ui/lightbox'
import { ContextMenu, MenuItem } from './ui/context-menu'

// Attachments section + cover image. `attachment:add` is a native
// file-dialog IPC (separate from the mutate channel); delete + cover
// toggling go through the standard mutate channel. Files are served
// via the `kanbini-file://` protocol (sandboxed to userData/
// attachments by the main process).

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

const IMAGE_EXTS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'tiff',
  'avif',
  'ico',
  'heic',
  'heif'
])
const isImage = (a: AttachmentView): boolean => {
  if (a.mime?.startsWith('image/')) return true
  // Extension fallback - main's MIME map may not cover every format.
  const ext = a.filename.toLowerCase().split('.').pop() ?? ''
  return IMAGE_EXTS.has(ext)
}

// Chromium canonicalises standard-scheme URLs so the first path segment
// becomes the host. We emit `kanbini-file://attachments/<id>/<file>`
// (no triple-slash) to match what the protocol handler in main expects
// (host + pathname recombined).
const srcFor = (a: AttachmentView): string =>
  `kanbini-file://${a.relPath.split(/[\\/]/).map(encodeURIComponent).join('/')}`

function humanSize(bytes: number | null): string {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

/** Small in-list cover thumbnail (M4-H). Bleeds to the card's edges
 *  via negative margins so it acts as a banner without redesigning
 *  the surrounding padding. Renders nothing when the card has no
 *  cover or the cover isn't an image. Adds a small domain chip
 *  overlay when the cover came from a URL fetch (ADR-0023).
 *
 *  Pointer events bubble freely (no stopPropagation) so dragging
 *  from the cover starts a card drag like dragging from the title.
 *  The 6 px PointerSensor activation distance disambiguates click
 *  vs drag, so an onClick still works.
 *
 *  When `onClick` is provided (in-list card) the thumb opens the
 *  card on click; the drag-overlay copy omits it (no interaction). */
export function CardCoverThumb({
  card,
  onClick
}: {
  card: CardView
  onClick?: () => void
}) {
  const cover = card.coverAttachmentId
    ? card.attachments.find((a) => a.id === card.coverAttachmentId)
    : null
  if (!cover || !isImage(cover)) return null
  const domain = cover.sourceUrl ? domainOf(cover.sourceUrl) : null
  return (
    <div
      className={`relative -mx-3 -mt-2 mb-1 overflow-hidden rounded-t-[5px] border-b border-border bg-muted${
        onClick ? ' cursor-pointer' : ''
      }`}
      onClick={onClick}
    >
      <img
        src={srcFor(cover)}
        alt=""
        className="block h-20 w-full object-cover"
      />
      {domain && (
        <span
          title={
            cover.sourceTitle
              ? decodeHtmlEntities(cover.sourceTitle)
              : (cover.sourceUrl ?? undefined)
          }
          className="absolute bottom-1 left-1 inline-flex max-w-[80%] items-center gap-1 truncate rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white"
        >
          <Globe className="size-2.5 shrink-0" />
          <span className="truncate">{domain}</span>
        </span>
      )}
    </div>
  )
}

/** Cover image at the top of the card detail modal. Click to expand.
 *  When the cover came from a URL fetch (ADR-0023), a footer row
 *  below the image carries the source title + a clickable link
 *  (main's setWindowOpenHandler routes http(s) to shell.openExternal). */
export function CoverImage({ card }: { card: CardView }) {
  const [open, setOpen] = useState(false)
  const cover = card.coverAttachmentId
    ? card.attachments.find((a) => a.id === card.coverAttachmentId)
    : null
  if (!cover || !isImage(cover)) return null
  // Capture as a const so the `&&` narrowing below survives into the
  // ContextMenu render-prop closures (a `cover.sourceUrl` property
  // access wouldn't narrow inside a nested function).
  const sourceUrl = cover.sourceUrl
  const domain = sourceUrl ? domainOf(sourceUrl) : null
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block w-full overflow-hidden rounded-t-lg bg-muted"
        aria-label="Expand cover image"
      >
        <img
          src={srcFor(cover)}
          alt={cover.filename}
          className="block max-h-72 w-full object-cover"
        />
      </button>
      {sourceUrl && (
        <ContextMenu
          width={180}
          menu={(close) => (
            <>
              <MenuItem
                onClick={() => {
                  void navigator.clipboard.writeText(sourceUrl).catch(() => {})
                  close()
                }}
              >
                Copy link
              </MenuItem>
              <MenuItem
                onClick={() => {
                  // main's setWindowOpenHandler routes http(s) to
                  // shell.openExternal (same path the left-click <a> takes).
                  window.open(sourceUrl, '_blank', 'noopener,noreferrer')
                  close()
                }}
              >
                Open link
              </MenuItem>
            </>
          )}
        >
          {(openMenu) => (
            <div
              onContextMenu={openMenu}
              className="flex items-center gap-2 border-b border-border bg-card/60 px-4 py-2 text-sm"
            >
              <Globe className="size-3.5 shrink-0 text-muted-foreground" />
              <a
                href={sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="min-w-0 flex-1 truncate text-foreground hover:underline"
                title={sourceUrl}
              >
                {cover.sourceTitle
                  ? decodeHtmlEntities(cover.sourceTitle)
                  : sourceUrl}
              </a>
              {domain && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {domain}
                </span>
              )}
            </div>
          )}
        </ContextMenu>
      )}
      {!sourceUrl && (
        // Restore the bottom border that the URL footer would
        // otherwise carry, so the cover always separates cleanly
        // from the modal body below.
        <div className="border-b border-border" />
      )}
      {open && (
        <ImageLightbox
          src={srcFor(cover)}
          alt={cover.filename}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

/** M4-H follow-up · second entry point for the Cover picker, mirroring
 *  the three actions in the right-click `CardMenu` (Set from file… /
 *  Set from URL… / Remove cover). Lives inside the card detail's
 *  Attachments section so a user with the modal open doesn't have to
 *  close it, right-click the in-list card, then reopen just to change
 *  a cover. The URL path delegates to `<UrlCoverModal>` via the
 *  `onRequestUrl` callback (parent owns the modal so it survives
 *  any context-menu unmount on a separate code path, same pattern as
 *  SortableCard). */
export function CoverActions({
  card,
  apply,
  onRequestUrl
}: {
  card: CardView
  apply: Apply
  onRequestUrl: () => void
}) {
  const [busy, setBusy] = useState(false)
  // Two-step IPC (upload + set cover). Bypasses the optimistic helper
  // because the new attachment id is only known after the upload
  // completes; the broadcastChange that follows the second `mutate`
  // reconciles the cache. Identical logic to CardMenu's
  // `setCoverFromFile`; left duplicated rather than factored out
  // because the helper is two awaited calls.
  const setCoverFromFile = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
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
    } finally {
      setBusy(false)
    }
  }
  const removeCover = (): void => {
    apply(
      { type: 'card.update', id: card.id, patch: { coverAttachmentId: null } },
      (b) => mapCard(b, card.id, (c) => ({ ...c, coverAttachmentId: null }))
    )
  }
  return (
    <div
      data-testid="cover-actions"
      className="flex flex-wrap items-center gap-1.5"
    >
      <span className="text-xs font-medium text-muted-foreground">
        Cover:
      </span>
      <button
        type="button"
        onClick={() => void setCoverFromFile()}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded border border-border bg-background px-2 py-1 text-xs text-foreground hover:border-ring disabled:cursor-wait disabled:opacity-60"
      >
        <FileImage className="size-3.5" />
        {busy ? 'Uploading…' : 'Set from file…'}
      </button>
      <button
        type="button"
        onClick={onRequestUrl}
        className="inline-flex items-center gap-1.5 rounded border border-border bg-background px-2 py-1 text-xs text-foreground hover:border-ring"
      >
        <Globe className="size-3.5" />
        Set from URL…
      </button>
      {card.coverAttachmentId && (
        <button
          type="button"
          onClick={removeCover}
          className="inline-flex items-center gap-1.5 rounded border border-border bg-background px-2 py-1 text-xs text-muted-foreground hover:border-ring hover:text-foreground"
        >
          <ImageOff className="size-3.5" />
          Remove cover
        </button>
      )}
    </div>
  )
}

export function Attachments({
  card,
  apply
}: {
  card: CardView
  apply: Apply
}) {
  const [busy, setBusy] = useState(false)

  const add = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await ipc.attachmentAdd(card.id)
      // The main process broadcasts `changed` after createAttachment,
      // so the board query refetches and the new row appears.
    } finally {
      setBusy(false)
    }
  }

  const del = (id: string): void => {
    apply({ type: 'attachment.delete', id }, (b) =>
      mapCard(b, card.id, (c) => ({
        ...c,
        attachments: c.attachments.filter((a) => a.id !== id),
        coverAttachmentId:
          c.coverAttachmentId === id ? null : c.coverAttachmentId
      }))
    )
  }

  const setCover = (attachmentId: string | null): void => {
    apply(
      {
        type: 'card.update',
        id: card.id,
        patch: { coverAttachmentId: attachmentId }
      },
      (b) =>
        mapCard(b, card.id, (c) => ({ ...c, coverAttachmentId: attachmentId }))
    )
  }

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">
          Attachments
        </h3>
        <button
          onClick={add}
          disabled={busy}
          className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          {busy ? 'Adding…' : '+ Add attachment'}
        </button>
      </div>
      {card.attachments.length === 0 && (
        <p className="text-xs text-muted-foreground/70">No attachments yet.</p>
      )}
      {card.attachments.map((att) => (
        <AttachmentRow
          key={att.id}
          att={att}
          isCover={card.coverAttachmentId === att.id}
          onDelete={() => del(att.id)}
          onSetCover={() => setCover(att.id)}
          onRemoveCover={() => setCover(null)}
        />
      ))}
    </section>
  )
}

function AttachmentRow({
  att,
  isCover,
  onDelete,
  onSetCover,
  onRemoveCover
}: {
  att: AttachmentView
  isCover: boolean
  onDelete: () => void
  onSetCover: () => void
  onRemoveCover: () => void
}) {
  const img = isImage(att)
  const [preview, setPreview] = useState(false)
  const [thumbError, setThumbError] = useState(false)
  const showThumb = img && !thumbError
  return (
    <div className="group/att flex items-center gap-3 rounded-md border border-border bg-background/40 p-2">
      {showThumb ? (
        <button
          type="button"
          onClick={() => setPreview(true)}
          className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded bg-muted"
          aria-label="Preview image"
        >
          <img
            src={srcFor(att)}
            alt=""
            onError={() => setThumbError(true)}
            className="size-full object-cover"
          />
        </button>
      ) : (
        <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
          <FileIcon className="size-5 text-muted-foreground" />
        </div>
      )}
      {preview && img && (
        <ImageLightbox
          src={srcFor(att)}
          alt={att.filename}
          onClose={() => setPreview(false)}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">{att.filename}</span>
        <span className="text-xs text-muted-foreground">
          {humanSize(att.size)}
          {isCover && (
            <span className="ml-2 rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              Cover
            </span>
          )}
        </span>
      </div>
      <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover/att:opacity-100">
        {img &&
          (isCover ? (
            <button
              onClick={onRemoveCover}
              className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Remove cover
            </button>
          ) : (
            <button
              onClick={onSetCover}
              className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Make cover
            </button>
          ))}
        <button
          aria-label="Delete attachment"
          onClick={onDelete}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  )
}
