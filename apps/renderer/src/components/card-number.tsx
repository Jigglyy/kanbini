import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { formatCardNumber } from '@kanbini/shared'

// A card's short #N (counted per board, never reused there) - the
// handle people use to refer to a card. Two surfaces: a muted badge at
// the end of a list card's meta row (hidden by Settings -> Cards ->
// "Show card numbers"), and a copy button in the card detail header,
// which always shows so a number can be found with the badge off.
// Number 0 = an optimistic card the server hasn't numbered yet: render
// nothing rather than "#0".

/** In-list badge. `ml-auto` pins it to the right edge of the meta row
 *  (or of its own line when the row wraps). */
export function CardNumberBadge({ number }: { number: number }) {
  if (number <= 0) return null
  return (
    <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
      {formatCardNumber(number)}
    </span>
  )
}

/** Card-detail header button: shows "#N", copies it on click, and
 *  briefly swaps in a check so the copy is confirmed without a toast. */
export function CardNumberCopy({ number }: { number: number }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(t)
  }, [copied])
  if (number <= 0) return null
  const text = formatCardNumber(number)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => setCopied(true))
          .catch(() => {})
      }}
      aria-label={copied ? `Copied ${text}` : `Copy card number ${text}`}
      title="Copy card number"
      className="ml-auto inline-flex shrink-0 items-center gap-1 rounded px-1 tabular-nums text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {copied && <Check aria-hidden className="size-3 text-emerald-500" />}
      {text}
    </button>
  )
}
