import { describe, expect, it } from 'vitest'
import { startupBoardId } from '../startup'

// Settings, Startup: which board the app opens on launch.

const boards = [
  { id: 'a', archived: false },
  { id: 'b', archived: false },
  { id: 'old', archived: true }
]
const opts = (over: Partial<Parameters<typeof startupBoardId>[1]> = {}) => ({
  startBoardId: null,
  lastBoardId: null,
  boards,
  ...over
})

describe('startupBoardId', () => {
  it('opens nothing in home mode', () => {
    expect(startupBoardId('home', opts({ startBoardId: 'a', lastBoardId: 'b' }))).toBeNull()
  })

  it('reopens the last board when it still exists', () => {
    expect(startupBoardId('lastBoard', opts({ lastBoardId: 'b' }))).toBe('b')
    expect(startupBoardId('lastBoard', opts({ lastBoardId: 'gone' }))).toBeNull()
    expect(startupBoardId('lastBoard', opts())).toBeNull()
  })

  it('opens the picked board, not the last one', () => {
    expect(startupBoardId('board', opts({ startBoardId: 'a', lastBoardId: 'b' }))).toBe('a')
  })

  it('falls back to the boards list for a deleted or archived pick', () => {
    expect(startupBoardId('board', opts({ startBoardId: 'gone' }))).toBeNull()
    expect(startupBoardId('board', opts({ startBoardId: 'old' }))).toBeNull()
    expect(startupBoardId('board', opts())).toBeNull()
  })
})
