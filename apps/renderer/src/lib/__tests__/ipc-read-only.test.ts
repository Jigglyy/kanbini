import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ipc } from '../ipc'
import {
  ReadOnlyError,
  onWriteBlocked,
  setBoardReadOnly,
  useReadOnlyScope
} from '../read-only'
import { kanbiniMock } from '../../__tests__/_kanbini-mock'

// The renderer's one write funnel refuses the guarded writes while a
// locked board is on screen, and board-level writes that name a locked
// board from anywhere (the home screen). The AI writes through the
// control channel, so none of this reaches it.

const rename = { type: 'card.update', id: 'c1', patch: { title: 'x' } } as const

describe('ipc read-only guard', () => {
  it('rejects guarded writes while a locked board is on screen', async () => {
    setBoardReadOnly('b1', true)
    renderHook(() => useReadOnlyScope('b1'))
    const blocked = vi.fn()
    const off = onWriteBlocked(blocked)
    const m = kanbiniMock()
    await expect(ipc.mutate(rename)).rejects.toBeInstanceOf(ReadOnlyError)
    await expect(ipc.mutateBatch([rename])).rejects.toBeInstanceOf(ReadOnlyError)
    await expect(ipc.attachmentAdd('c1')).rejects.toBeInstanceOf(ReadOnlyError)
    await expect(ipc.attachmentPasteImage('c1')).rejects.toBeInstanceOf(ReadOnlyError)
    await expect(ipc.linkPreviewCreate({ cardId: 'c1', url: 'https://x.test' })).rejects.toBeInstanceOf(ReadOnlyError)
    await expect(ipc.boardSetBackgroundImage({ boardId: 'b1' })).rejects.toBeInstanceOf(ReadOnlyError)
    await expect(ipc.undoApply({ scopeBoardId: 'b1' })).rejects.toBeInstanceOf(ReadOnlyError)
    await expect(ipc.redoApply({ scopeBoardId: 'b1' })).rejects.toBeInstanceOf(ReadOnlyError)
    expect(m.mutate).not.toHaveBeenCalled()
    expect(m.mutateBatch).not.toHaveBeenCalled()
    expect(m.attachmentAdd).not.toHaveBeenCalled()
    expect(m.attachmentPasteImage).not.toHaveBeenCalled()
    expect(m.linkPreviewCreate).not.toHaveBeenCalled()
    expect(m.boardSetBackgroundImage).not.toHaveBeenCalled()
    expect(m.undoApply).not.toHaveBeenCalled()
    expect(m.redoApply).not.toHaveBeenCalled()
    expect(blocked).toHaveBeenCalledWith('b1')
    off()
  })

  it('lets ticks through a locked board on screen, alone or as an all-ticks batch', async () => {
    setBoardReadOnly('b1', true)
    renderHook(() => useReadOnlyScope('b1'))
    const blocked = vi.fn()
    const off = onWriteBlocked(blocked)
    const tickItem = { type: 'checklistItem.update', id: 'i1', patch: { completed: true } } as const
    const tickCard = { type: 'card.update', id: 'c1', patch: { completed: false } } as const
    await ipc.mutate(tickItem)
    await ipc.mutate(tickCard)
    await ipc.mutateBatch([tickItem, tickCard])
    expect(kanbiniMock().mutate).toHaveBeenCalledWith(tickItem)
    expect(kanbiniMock().mutate).toHaveBeenCalledWith(tickCard)
    expect(kanbiniMock().mutateBatch).toHaveBeenCalledWith([tickItem, tickCard])
    expect(blocked).not.toHaveBeenCalled()
    off()
  })

  it('a tick with anything else in it is still refused', async () => {
    setBoardReadOnly('b1', true)
    renderHook(() => useReadOnlyScope('b1'))
    const tick = { type: 'card.update', id: 'c1', patch: { completed: true } } as const
    await expect(
      ipc.mutate({ type: 'checklistItem.update', id: 'i1', patch: { text: 'x' } })
    ).rejects.toBeInstanceOf(ReadOnlyError)
    await expect(
      ipc.mutate({ type: 'card.update', id: 'c1', patch: { completed: true, title: 'x' } })
    ).rejects.toBeInstanceOf(ReadOnlyError)
    await expect(ipc.mutateBatch([tick, rename])).rejects.toBeInstanceOf(ReadOnlyError)
    expect(kanbiniMock().mutate).not.toHaveBeenCalled()
    expect(kanbiniMock().mutateBatch).not.toHaveBeenCalled()
  })

  it('passes writes through when the board on screen is unlocked', async () => {
    renderHook(() => useReadOnlyScope('b1'))
    await ipc.mutate(rename)
    await ipc.undoApply({ scopeBoardId: 'b1' })
    expect(kanbiniMock().mutate).toHaveBeenCalledWith(rename)
    expect(kanbiniMock().undoApply).toHaveBeenCalled()
  })

  it('reads still work on a locked board', async () => {
    setBoardReadOnly('b1', true)
    renderHook(() => useReadOnlyScope('b1'))
    await ipc.getBoardView('b1')
    await ipc.searchCards({ query: 'x', limit: 5 })
    expect(kanbiniMock().getBoardView).toHaveBeenCalled()
    expect(kanbiniMock().searchCards).toHaveBeenCalled()
  })

  it('refuses a rename of a locked board with no board on screen', async () => {
    setBoardReadOnly('b1', true)
    await expect(
      ipc.mutate({ type: 'board.update', id: 'b1', patch: { name: 'New' } })
    ).rejects.toBeInstanceOf(ReadOnlyError)
    await expect(
      ipc.mutateBatch([{ type: 'board.delete', id: 'b1' }])
    ).rejects.toBeInstanceOf(ReadOnlyError)
    expect(kanbiniMock().mutate).not.toHaveBeenCalled()
    expect(kanbiniMock().mutateBatch).not.toHaveBeenCalled()
  })

  it('lets the home screen favourite and reorder a locked board', async () => {
    setBoardReadOnly('b1', true)
    const pin = { type: 'board.update', id: 'b1', patch: { pinned: true } } as const
    const move = { type: 'board.move', id: 'b1', beforeId: null, afterId: 'b2' } as const
    await ipc.mutate(pin)
    await ipc.mutate(move)
    expect(kanbiniMock().mutate).toHaveBeenCalledWith(pin)
    expect(kanbiniMock().mutate).toHaveBeenCalledWith(move)
  })

  it('a pinned patch with another field is still a rename', async () => {
    setBoardReadOnly('b1', true)
    await expect(
      ipc.mutate({ type: 'board.update', id: 'b1', patch: { pinned: true, name: 'x' } })
    ).rejects.toBeInstanceOf(ReadOnlyError)
  })

  it('other boards are unaffected by a locked one off screen', async () => {
    setBoardReadOnly('b1', true)
    renderHook(() => useReadOnlyScope('b2'))
    await ipc.mutate({ type: 'board.update', id: 'b2', patch: { name: 'Fine' } })
    await ipc.mutate(rename)
    expect(kanbiniMock().mutate).toHaveBeenCalledTimes(2)
  })

  it('duplicating a locked board is not an edit of it', async () => {
    setBoardReadOnly('b1', true)
    const dup = { type: 'board.duplicate', id: 'b1' } as const
    await ipc.mutate(dup)
    expect(kanbiniMock().mutate).toHaveBeenCalledWith(dup)
  })

  it('undo / redo tell main which boards are locked, scoped or not', async () => {
    setBoardReadOnly('b1', true)
    setBoardReadOnly('b3', true)
    await ipc.undoApply({})
    await ipc.redoApply()
    expect(kanbiniMock().undoApply).toHaveBeenCalledWith({ lockedBoardIds: ['b1', 'b3'] })
    expect(kanbiniMock().redoApply).toHaveBeenCalledWith({ lockedBoardIds: ['b1', 'b3'] })
    // Scoped on an unlocked board: main still needs the list, to refuse
    // an entry that would reach a locked board.
    await ipc.undoApply({ scopeBoardId: 'b2' })
    expect(kanbiniMock().undoApply).toHaveBeenLastCalledWith({
      scopeBoardId: 'b2',
      lockedBoardIds: ['b1', 'b3']
    })
  })

  it('nothing locked: the request goes as it was', async () => {
    await ipc.undoApply({ scopeBoardId: 'b2' })
    expect(kanbiniMock().undoApply).toHaveBeenCalledWith({ scopeBoardId: 'b2' })
  })

  it('lets view settings through a locked board on screen', async () => {
    setBoardReadOnly('b1', true)
    renderHook(() => useReadOnlyScope('b1'))
    const blocked = vi.fn()
    const off = onWriteBlocked(blocked)
    const views = [
      { type: 'card.update', id: 'c1', patch: { collapsed: true } },
      { type: 'list.update', id: 'l1', patch: { visibleCardLimit: 10 } },
      { type: 'list.update', id: 'l1', patch: { cardDensity: 'compact' } },
      { type: 'board.update', id: 'b1', patch: { swimlaneMode: 'priority' } }
    ] as const
    for (const m of views) await ipc.mutate(m)
    expect(kanbiniMock().mutate).toHaveBeenCalledTimes(views.length)
    expect(blocked).not.toHaveBeenCalled()
    // A view setting with a real edit in the same patch is still refused.
    await expect(
      ipc.mutate({ type: 'list.update', id: 'l1', patch: { visibleCardLimit: 10, name: 'x' } })
    ).rejects.toBeInstanceOf(ReadOnlyError)
    off()
  })
})
