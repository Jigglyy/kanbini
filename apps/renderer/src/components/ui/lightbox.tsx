import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

// Full-viewport image preview. Esc / click outside the image / X to
// close. Renders in a body portal so it always sits above modals.

export function ImageLightbox({
  src,
  alt,
  onClose
}: {
  src: string
  alt: string
  onClose: () => void
}) {
  useEffect(() => {
    // The lightbox is opened from INSIDE a CardDetail Modal (cover /
    // attachment thumbnail). The Modal closes on a document keydown
    // listener too, so a single Escape used to close BOTH (dismiss the
    // image AND the card detail). We can't rely on the Modal's
    // mount-order escape-stack here: the lightbox is a DESCENDANT of the
    // Modal, and with unstable onClose refs the effect re-runs land the
    // parent Modal on top of the stack. Instead, listen in the CAPTURE
    // phase - which always precedes the Modal's bubble-phase listener,
    // regardless of mount/render order - and stop the event so the
    // Modal underneath never sees it.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = prev
    }
  }, [onClose])

  return createPortal(
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6 backdrop-blur-sm"
    >
      <button
        aria-label="Close"
        onClick={onClose}
        className="absolute right-4 top-4 rounded p-1 text-white/80 hover:bg-white/10 hover:text-white"
      >
        <X className="size-5" />
      </button>
      <img
        onClick={(e) => e.stopPropagation()}
        src={src}
        alt={alt}
        className="max-h-[90vh] max-w-[90vw] rounded-md object-contain shadow-2xl"
      />
    </div>,
    document.body
  )
}
