import { afterEach, describe, expect, it, vi } from 'vitest'
import { whenCardMounted } from '../when-card-mounted'

// Scrolling to a card that a revealed list mounts a few renders later
// (the Ctrl+F "show on board" scroll used to give up after two frames).

const frames: Array<() => void> = []
const raf = (cb: () => void) => frames.push(cb)
const nextFrame = () => frames.splice(0, frames.length).forEach((cb) => cb())

const mountCard = (id: string) => {
  const li = document.createElement('li')
  li.dataset['cardId'] = id
  document.body.appendChild(li)
  return li
}

afterEach(() => {
  frames.length = 0
  document.body.innerHTML = ''
})

describe('whenCardMounted', () => {
  it('waits for the next frame even when the card is already there', () => {
    const li = mountCard('a')
    const run = vi.fn()
    whenCardMounted('a', run, { raf })
    expect(run).not.toHaveBeenCalled()
    nextFrame()
    expect(run).toHaveBeenCalledWith(li)
  })

  it('keeps checking until the card mounts, however many frames that takes', () => {
    const run = vi.fn()
    whenCardMounted('late', run, { raf })
    for (let i = 0; i < 5; i++) nextFrame()
    expect(run).not.toHaveBeenCalled()
    const li = mountCard('late')
    nextFrame()
    expect(run).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledWith(li)
    nextFrame()
    expect(run).toHaveBeenCalledOnce()
  })

  it('gives up when the card never shows', () => {
    const run = vi.fn()
    whenCardMounted('never', run, { raf, maxFrames: 3 })
    for (let i = 0; i < 10; i++) nextFrame()
    expect(run).not.toHaveBeenCalled()
    expect(frames).toHaveLength(0)
  })
})
