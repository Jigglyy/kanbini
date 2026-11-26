import type { AttachmentView, CardView } from '@kanbini/shared'
import type { MediaItem } from '../components/ui/media-viewer'

// What kind of thing an attachment is, and where its file is served.
// Shared by the attachment list, the covers and the media viewer.

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
/** Video containers Chromium plays (a .mov is served as MP4, see main's
 *  kanbini-file handler). */
const VIDEO_EXTS = new Set(['mp4', 'm4v', 'webm', 'mov', 'ogv'])

const extOf = (name: string): string => name.toLowerCase().split('.').pop() ?? ''

export function isImage(a: Pick<AttachmentView, 'mime' | 'filename'>): boolean {
  if (a.mime?.startsWith('image/')) return true
  // Extension fallback - main's MIME map may not cover every format.
  return IMAGE_EXTS.has(extOf(a.filename))
}

export function isVideo(a: Pick<AttachmentView, 'mime' | 'filename'>): boolean {
  if (a.mime?.startsWith('video/')) return true
  return VIDEO_EXTS.has(extOf(a.filename))
}

/** Chromium canonicalises standard-scheme URLs so the first path segment
 *  becomes the host. We emit `kanbini-file://attachments/<id>/<file>`
 *  (no triple-slash) to match what the protocol handler in main expects
 *  (host + pathname recombined). */
export const srcFor = (a: Pick<AttachmentView, 'relPath'>): string =>
  `kanbini-file://${a.relPath.split(/[\/]/).map(encodeURIComponent).join('/')}`

/** A video's poster: its first frame, without loading the whole file. */
export const videoPosterSrc = (a: Pick<AttachmentView, 'relPath'>): string => `${srcFor(a)}#t=0.1`

export function humanSize(bytes: number | null): string {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

/** A card's images and videos, in attachment order, for the viewer. */
export function cardMedia(card: Pick<CardView, 'attachments'>): MediaItem[] {
  return card.attachments.flatMap((a): MediaItem[] => {
    const kind = isImage(a) ? 'image' : isVideo(a) ? 'video' : null
    return kind ? [{ id: a.id, src: srcFor(a), name: a.filename, kind, size: a.size }] : []
  })
}
