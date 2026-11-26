import { useRef, useState } from 'react'
import {
  ExternalLink,
  File as FileIcon,
  FileImage,
  Globe,
  ImageOff,
  Maximize2,
  Play,
  X
} from 'lucide-react'
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
import { cardMedia, humanSize, isImage, isVideo, srcFor, videoPosterSrc } from '../lib/media'
import { MediaViewer } from './ui/media-viewer'
import { ContextMenu, MenuItem } from './ui/context-menu'

export { humanSize }

/** "Open in default app" hands the file to the OS. The web edition can't
 *  (apps/web/swaps.ts turns this off; it has a Download link instead). */
const CAN_OPEN_IN_APP = true

/** Open an attachment in the OS's default app; resolves to the reason
 *  when it didn't (no app for the type, a program shown in its folder). */
async function openInApp(id: string): Promise<string | null> {
  try {
    const r = await ipc.attachmentOpen(id)
    return r.ok ? null : (r.error ?? "Couldn't open the file.")
  } catch {
    return "Couldn't open the file."
  }
}

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
  const video = !!cover && !isImage(cover) && isVideo(cover)
  if (!cover || (!isImage(cover) && !video)) return null
  const domain = cover.sourceUrl ? domainOf(cover.sourceUrl) : null
  return (
    <div
      className={`relative -mx-3 -mt-2 mb-1 overflow-hidden rounded-t-[5px] border-b border-border bg-muted${
        onClick ? ' cursor-pointer' : ''
      }`}
      onClick={onClick}
    >
      {video ? (
        // A still frame on the board (no autoplay on a busy board); it
        // plays in the card's detail.
        <>
          <video
            src={videoPosterSrc(cover)}
            preload="metadata"
            muted
            playsInline
            aria-hidden
            className="pointer-events-none block h-20 w-full bg-black object-cover"
          />
          <PlayBadge />
        </>
      ) : (
        <img
          src={srcFor(cover)}
          alt=""
          className="block h-20 w-full object-cover"
        />
      )}
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
  const video = !!cover && !isImage(cover) && isVideo(cover)
  if (!cover || (!isImage(cover) && !video)) return null
  // Capture as a const so the `&&` narrowing below survives into the
  // ContextMenu render-prop closures (a `cover.sourceUrl` property
  // access wouldn't narrow inside a nested function).
  const sourceUrl = cover.sourceUrl
  const domain = sourceUrl ? domainOf(sourceUrl) : null
  const media = cardMedia(card)
  return (
    <>
      {video ? (
        // A video cover plays right here; the corner button opens it in
        // the full viewer with the card's other media.
        <div className="relative overflow-hidden rounded-t-lg bg-black">
          <video
            src={srcFor(cover)}
            controls
            preload="metadata"
            aria-label={cover.filename}
            className="block max-h-72 w-full object-contain"
          />
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Expand cover video"
            className="absolute right-2 top-2 rounded bg-black/60 p-1 text-white/90 hover:bg-black/80 hover:text-white"
          >
            <Maximize2 className="size-4" />
          </button>
        </div>
      ) : (
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
      )}
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
        <MediaViewer
          items={media}
          startIndex={Math.max(0, media.findIndex((m) => m.id === cover.id))}
          onClose={() => setOpen(false)}
          onOpenInApp={CAN_OPEN_IN_APP ? openInApp : undefined}
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
  apply,
  readOnly = false
}: {
  card: CardView
  apply: Apply
  /** Locked board (ADR-0089): the files can be opened, not changed. */
  readOnly?: boolean
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

  // The card's images + videos, and the one open in the viewer (by id).
  const media = cardMedia(card)
  const [viewing, setViewing] = useState<string | null>(null)

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">
          Attachments
        </h3>
        {!readOnly && (
          <button
            onClick={add}
            disabled={busy}
            className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            {busy ? 'Adding…' : '+ Add attachment'}
          </button>
        )}
      </div>
      {card.attachments.length === 0 && (
        <p className="text-xs text-muted-foreground/70">
          No attachments yet.
          {!readOnly && ' Drop files here or paste them with Ctrl+V.'}
        </p>
      )}
      {card.attachments.map((att) => (
        <AttachmentRow
          key={att.id}
          att={att}
          isCover={card.coverAttachmentId === att.id}
          onPreview={() => setViewing(att.id)}
          onDelete={() => del(att.id)}
          onSetCover={() => setCover(att.id)}
          onRemoveCover={() => setCover(null)}
          readOnly={readOnly}
        />
      ))}
      {viewing && (
        <MediaViewer
          items={media}
          startIndex={Math.max(0, media.findIndex((m) => m.id === viewing))}
          onClose={() => setViewing(null)}
          onOpenInApp={CAN_OPEN_IN_APP ? openInApp : undefined}
        />
      )}
    </section>
  )
}

/** The round play mark on a video's still frame. */
function PlayBadge({ small = false }: { small?: boolean }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-0 flex items-center justify-center"
    >
      <span className={`rounded-full bg-black/60 text-white ${small ? 'p-1' : 'p-1.5'}`}>
        <Play className={small ? 'size-3 fill-current' : 'size-4 fill-current'} />
      </span>
    </span>
  )
}

function AttachmentRow({
  att,
  isCover,
  onPreview,
  onDelete,
  onSetCover,
  onRemoveCover,
  readOnly
}: {
  att: AttachmentView
  isCover: boolean
  /** Open it in the media viewer (images and videos). */
  onPreview: () => void
  onDelete: () => void
  onSetCover: () => void
  onRemoveCover: () => void
  readOnly: boolean
}) {
  const img = isImage(att)
  const video = !img && isVideo(att)
  const [thumbError, setThumbError] = useState(false)
  // Why "Open in default app" didn't (shown under the name for a while).
  const [openError, setOpenError] = useState<string | null>(null)
  const open = async (): Promise<void> => {
    const error = await openInApp(att.id)
    setOpenError(error)
    if (error) window.setTimeout(() => setOpenError(null), 6000)
  }
  return (
    <div className="group/att flex items-center gap-3 rounded-md border border-border bg-background/40 p-2">
      {img && !thumbError ? (
        <button
          type="button"
          onClick={onPreview}
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
      ) : video && !thumbError ? (
        <button
          type="button"
          onClick={onPreview}
          className="relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded bg-black"
          aria-label="Play video"
        >
          <video
            src={videoPosterSrc(att)}
            preload="metadata"
            muted
            playsInline
            onError={() => setThumbError(true)}
            className="pointer-events-none size-full object-cover"
          />
          <PlayBadge small />
        </button>
      ) : (
        <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
          <FileIcon className="size-5 text-muted-foreground" />
        </div>
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
        {openError && (
          <span role="alert" className="text-xs text-danger">
            {openError}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/att:opacity-100">
        {(img || video) &&
          !readOnly &&
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
        {CAN_OPEN_IN_APP && (
          <button
            type="button"
            aria-label="Open in default app"
            title="Open in default app"
            onClick={() => void open()}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
          </button>
        )}
        {/* `hidden`, not a condition: the web edition's swap inserts a
            Download link right before this button (apps/web/swaps.ts),
            which must stay a plain sibling to remain valid JSX. */}
        <button
          aria-label="Delete attachment"
          hidden={readOnly}
          onClick={onDelete}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  )
}

/** Files dragged in from the file manager can be dropped anywhere on an
 *  open card to attach them (any type: a GIF keeps its animation). Shows
 *  a dashed "Drop to attach" over the card while files hover it. Locked
 *  board (`disabled`): the drop is swallowed, nothing is attached. Only
 *  reacts to file drags, so text or link drags inside the card are left
 *  alone. */
export function FileDropZone({
  cardId,
  disabled,
  children
}: {
  cardId: string
  disabled: boolean
  children: React.ReactNode
}) {
  const [over, setOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // dragenter / dragleave fire for every child crossed; count them.
  const depth = useRef(0)
  const hasFiles = (e: React.DragEvent): boolean =>
    Array.from(e.dataTransfer.types).includes('Files')
  return (
    <div
      className="relative"
      onDragEnter={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        depth.current += 1
        if (!disabled) setOver(true)
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = disabled ? 'none' : 'copy'
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setOver(false)
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        depth.current = 0
        setOver(false)
        const files = Array.from(e.dataTransfer.files)
        if (disabled || files.length === 0) return
        setError(null)
        ipc.attachmentAddFiles(cardId, files).catch((err: unknown) => {
          setError(err instanceof Error ? err.message : "Couldn't attach those files.")
          window.setTimeout(() => setError(null), 6000)
        })
      }}
    >
      {children}
      {over && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-primary/10 text-sm font-medium text-primary"
        >
          Drop to attach
        </div>
      )}
      {error && (
        <p
          role="alert"
          className="absolute inset-x-5 bottom-3 z-20 rounded-md bg-card px-3 py-2 text-xs text-danger shadow"
        >
          {error}
        </p>
      )}
    </div>
  )
}
