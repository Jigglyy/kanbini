// Run something on a card's element once it's on the page. Moving TO a
// card (keyboard focus, Ctrl+F "show on board") can first reveal a list
// folded behind "Show N more", and the revealed cards mount in a later
// React render. That render isn't tied to a frame count: a big reveal is
// rendered in slices, so "wait two frames" sometimes ran before the card
// existed and the scroll silently did nothing. Check every frame instead,
// starting with the next one (so React has committed the focus change),
// and give up after `maxFrames` (about a second) if the card never shows.

const MAX_FRAMES = 60

export function whenCardMounted(
  cardId: string,
  run: (node: HTMLElement) => void,
  opts: { maxFrames?: number; raf?: (cb: () => void) => unknown } = {}
): void {
  const raf = opts.raf ?? ((cb: () => void) => window.requestAnimationFrame(cb))
  const maxFrames = opts.maxFrames ?? MAX_FRAMES
  let frames = 0
  const tick = (): void => {
    const node = document.querySelector(`[data-card-id="${window.CSS.escape(cardId)}"]`)
    if (node instanceof HTMLElement) {
      run(node)
      return
    }
    frames += 1
    if (frames < maxFrames) raf(tick)
  }
  raf(tick)
}
