import type { Locator } from '@playwright/test'

// "Show on board" points a card out with a box-shadow glow played by
// the Web Animations API (renderer lib/card-glow.ts). Specs read it off
// the element's running animations: there's no class or attribute to
// look for, by design (React would wipe a class mid-glow).

/** True while `card` has a box-shadow glow running. */
export function isGlowing(card: Locator): Promise<boolean> {
  return card.evaluate((el) =>
    el.getAnimations().some(
      (a) =>
        a.playState === 'running' &&
        a.effect instanceof KeyframeEffect &&
        a.effect.getKeyframes().some((k) => 'boxShadow' in k)
    )
  )
}
