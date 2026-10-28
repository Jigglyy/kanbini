import { describe, expect, it, vi } from 'vitest'
import { CARD_GLOW_MS, glowCard } from '../card-glow'

describe('glowCard', () => {
  it('runs one box-shadow animation that fades back to nothing', () => {
    const el = document.createElement('li')
    el.style.setProperty('--color-primary', 'rgb(1, 2, 3)')
    const anim = { cancel: vi.fn() } as unknown as Animation
    el.animate = vi.fn(() => anim)

    expect(glowCard(el)).toBe(anim)
    const [frames, opts] = (el.animate as ReturnType<typeof vi.fn>).mock.calls[0]!
    // Only box-shadow: the card's transform / height belong to dnd-kit
    // and the hover height tween.
    for (const f of frames as Keyframe[]) {
      expect(Object.keys(f).filter((k) => k !== 'offset')).toEqual(['boxShadow'])
    }
    const shadows = (frames as Keyframe[]).map((f) => String(f.boxShadow))
    expect(shadows.some((s) => s.includes('rgb(1, 2, 3)'))).toBe(true)
    expect(shadows[shadows.length - 1]).toContain('transparent')
    expect(opts).toMatchObject({ duration: CARD_GLOW_MS })
  })

  it('cancels a glow still running on the same card before starting again', () => {
    const el = document.createElement('li')
    const first = { cancel: vi.fn() } as unknown as Animation
    const second = { cancel: vi.fn() } as unknown as Animation
    el.animate = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    glowCard(el)
    glowCard(el)
    expect(first.cancel).toHaveBeenCalledTimes(1)
  })

  it('does nothing where Web Animations are missing (JSDOM)', () => {
    const el = document.createElement('li')
    ;(el as { animate?: unknown }).animate = undefined
    expect(glowCard(el)).toBeNull()
  })
})
