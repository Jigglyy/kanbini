// "Show on board" highlight: a soft glow that fades by itself, so the
// eye finds a card without it looking selected (selection is the
// persistent ring + corner check). Web Animations on box-shadow only:
// the card's transform belongs to dnd-kit and its height to the hover
// tween (useSmoothHeight), and an element animation survives React
// rewriting the className mid-glow, which a CSS class wouldn't.

/** How long the glow lasts, start to fully faded. */
export const CARD_GLOW_MS = 2000

const running = new WeakMap<Element, Animation>()

/** Glow `el` once. A second glow on the same card restarts it. Returns
 *  null where Web Animations are missing (JSDOM). */
export function glowCard(el: HTMLElement): Animation | null {
  if (typeof el.animate !== 'function') return null
  running.get(el)?.cancel()
  // Read the theme token once: a var() inside the keyframes would be
  // resolved per frame and isn't something to rely on for animation.
  const color =
    getComputedStyle(el).getPropertyValue('--color-primary').trim() ||
    'currentColor'
  const lit = `0 0 0 2px ${color}, 0 0 16px 4px color-mix(in oklab, ${color} 45%, transparent)`
  const off = '0 0 0 2px transparent, 0 0 16px 4px transparent'
  const anim = el.animate(
    [
      { boxShadow: off, offset: 0 },
      { boxShadow: lit, offset: 0.08 },
      { boxShadow: lit, offset: 0.55 },
      { boxShadow: off, offset: 1 }
    ],
    { duration: CARD_GLOW_MS, easing: 'ease-out' }
  )
  running.set(el, anim)
  return anim
}
