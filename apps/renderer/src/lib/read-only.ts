import { createContext, useCallback, useEffect, useSyncExternalStore } from 'react'
import type { Mutation } from '@kanbini/shared'

// Per-board read-only lock (a view preference, like hide-completed:
// renderer-only, localStorage, never a DB column). It stops YOUR edits
// only: the AI writes through the desktop control channel, which never
// passes through the renderer, so a locked board still changes under it.
// Ticks (isTick) still pass: a locked board can be worked through.
//
// lib/ipc.ts is the guard; this module holds the lock, the boards on
// screen (scopes mounted by the board view and the card detail) and the
// "a write was blocked" signal the Read-only pill pulses on.

const STORAGE_KEY = 'kanbini.readOnlyBoards'

function readIds(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === 'string')
      : []
  } catch {
    return []
  }
}

const lockListeners = new Set<() => void>()
const notifyLock = (): void => lockListeners.forEach((l) => l())

// Follow toggles made in another window that shares this localStorage.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY || e.key === null) notifyLock()
  })
}

export function isBoardReadOnly(boardId: string): boolean {
  return readIds().includes(boardId)
}

/** A write the lock lets through: ticking a checklist item or a card
 *  done / not done, and nothing else in the same patch. Judged by the
 *  write, so every checkbox, menu item and shortcut behaves the same. */
export function isTick(m: Mutation): boolean {
  if (m.type !== 'checklistItem.update' && m.type !== 'card.update') return false
  const keys = Object.keys(m.patch)
  return keys.length === 1 && keys[0] === 'completed'
}

/** Every locked board id: an unscoped undo / redo asks main to skip
 *  the entries logged under them. */
export function readOnlyBoardIds(): string[] {
  return readIds()
}

export function setBoardReadOnly(boardId: string, locked: boolean): void {
  try {
    const ids = readIds().filter((id) => id !== boardId)
    if (locked) ids.push(boardId)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch {
    /* private mode - the lock can't be saved, so it isn't set either */
  }
  notifyLock()
}

function subscribeLock(cb: () => void): () => void {
  lockListeners.add(cb)
  return () => lockListeners.delete(cb)
}

/** The board's lock and a setter; re-renders when it flips anywhere. */
export function useBoardReadOnly(
  boardId: string | undefined
): [boolean, (locked: boolean) => void] {
  const locked = useSyncExternalStore(subscribeLock, () =>
    boardId ? isBoardReadOnly(boardId) : false
  )
  const set = useCallback(
    (next: boolean) => {
      if (boardId) setBoardReadOnly(boardId, next)
    },
    [boardId]
  )
  return [locked, set]
}

// Boards on screen, counted (the board view and its card detail both
// register). The guard refuses the guarded writes while one of them is
// locked, whatever the write targets: the renderer's writes don't all
// carry a board id, and on screen is where a stray click comes from.
const scopes = new Map<string, number>()

export function useReadOnlyScope(boardId: string | undefined): void {
  useEffect(() => {
    if (!boardId) return
    scopes.set(boardId, (scopes.get(boardId) ?? 0) + 1)
    return () => {
      const n = (scopes.get(boardId) ?? 1) - 1
      if (n <= 0) scopes.delete(boardId)
      else scopes.set(boardId, n)
    }
  }, [boardId])
}

/** A locked board that is on screen right now, or null. */
export function lockedScopeId(): string | null {
  const locked = readIds()
  for (const id of scopes.keys()) if (locked.includes(id)) return id
  return null
}

export class ReadOnlyError extends Error {
  constructor(readonly boardId: string) {
    super('This board is read-only. Unlock it to edit.')
    this.name = 'ReadOnlyError'
  }
}

const blockedListeners = new Set<(boardId: string) => void>()

export function onWriteBlocked(cb: (boardId: string) => void): () => void {
  blockedListeners.add(cb)
  return () => blockedListeners.delete(cb)
}

export function notifyWriteBlocked(boardId: string): void {
  blockedListeners.forEach((l) => l(boardId))
}

/** For entry points that hold a board id the guard can't see (the
 *  other card of a "Waiting on" link): true, and the blocked signal
 *  goes out, when it's locked. */
export function blockIfReadOnly(boardId: string): boolean {
  if (!isBoardReadOnly(boardId)) return false
  notifyWriteBlocked(boardId)
  return true
}

/** The board view's lock, for its deep children (add inputs, list
 *  headers, cards) without threading a prop through the memoised ones. */
export const ReadOnlyContext = createContext(false)
