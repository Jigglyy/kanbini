import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'

// Tiny custom tooltip - body-portaled so the card's `overflow-hidden`
// can't clip it. The browser's native `title=` attribute has a fixed
// ~500 ms delay we can't tune; this defaults to 200 ms, which feels
// snappy without flashing when you graze past an element. Inverted
// colour (foreground bg / background text) - standard tooltip look,
// auto-flips with the light/dark theme.

interface Props {
  label: string
  children: ReactNode
  /** ms before the tooltip appears after pointer enters. */
  delay?: number
  /** Which side of the trigger to anchor the tooltip on. */
  side?: 'top' | 'bottom'
}

export function Tooltip({ label, children, delay = 200, side = 'top' }: Props) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const wrapperRef = useRef<HTMLSpanElement>(null)
  const timerRef = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timerRef.current) window.clearTimeout(timerRef.current)
    },
    []
  )

  const show = (): void => {
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      // Measure the inner child rather than the wrapper - the wrapper
      // is inline-flex but the trigger might be larger if styled.
      const child = wrapperRef.current?.firstElementChild as HTMLElement | null
      const r = (child ?? wrapperRef.current)?.getBoundingClientRect()
      if (!r) return
      setPos({
        top: side === 'top' ? r.top - 6 : r.bottom + 6,
        left: r.left + r.width / 2
      })
      setOpen(true)
    }, delay)
  }
  const hide = (): void => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setOpen(false)
  }

  // Browser order on click is mousedown → focus → mouseup → click. Tying
  // show() to onFocus alone re-pops the tooltip immediately after every
  // click. Gate focus-show on :focus-visible (true for keyboard Tab,
  // false for mouse click) so keyboard users still get the hint while
  // mouse users don't get a tooltip flash after each click.
  const onFocusMaybeShow = (e: FocusEvent<HTMLSpanElement>): void => {
    const t = e.target as HTMLElement
    if (typeof t.matches === 'function' && t.matches(':focus-visible')) show()
  }

  return (
    <>
      <span
        ref={wrapperRef}
        onMouseEnter={show}
        onMouseLeave={hide}
        // Dismiss on click + clear any pending show timer so the
        // tooltip doesn't pop up after the user has taken an action.
        onMouseDown={hide}
        onFocus={onFocusMaybeShow}
        onBlur={hide}
        className="inline-flex"
      >
        {children}
      </span>
      {open &&
        pos &&
        createPortal(
          <div
            role="tooltip"
            style={{
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              transform: `translate(-50%, ${side === 'top' ? '-100%' : '0'})`,
              pointerEvents: 'none',
              zIndex: 100
            }}
            className="select-none whitespace-nowrap rounded-md bg-foreground/95 px-2 py-1 text-[11px] font-medium text-background shadow-md"
          >
            {label}
          </div>,
          document.body
        )}
    </>
  )
}
