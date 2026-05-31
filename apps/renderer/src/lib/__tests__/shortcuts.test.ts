import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import {
  ACTION_REGISTRY,
  DEFAULT_BINDINGS,
  actionFromEvent,
  bindingFromEvent,
  formatBinding,
  isTypingTarget,
  matchBinding,
  normalizeKey,
  resolveBindings,
  useShortcutDispatch,
  type ActionId,
  type Binding
} from '../shortcuts'

// Pure-logic coverage for the ADR-0035 shortcut layer. The matcher is
// where regressions hide (modifier flags, letter casing, special
// keys); the formatter is what users see in Settings → Shortcuts.
// Everything here is testable without a DOM beyond a synthetic
// KeyboardEvent.

function ev(
  key: string,
  mods: Partial<{
    ctrl: boolean
    alt: boolean
    shift: boolean
    meta: boolean
  }> = {}
): KeyboardEvent {
  // KeyboardEvent in JSDOM accepts the standard init. The matcher only
  // reads .key / .ctrlKey / .altKey / .shiftKey / .metaKey so we don't
  // need code / location / repeat.
  return new KeyboardEvent('keydown', {
    key,
    ctrlKey: mods.ctrl ?? false,
    altKey: mods.alt ?? false,
    shiftKey: mods.shift ?? false,
    metaKey: mods.meta ?? false
  })
}

describe('normalizeKey', () => {
  it('lowercases ASCII letters', () => {
    expect(normalizeKey('A')).toBe('a')
    expect(normalizeKey('z')).toBe('z')
  })

  it('leaves special keys alone (ArrowUp, Enter, Escape, …)', () => {
    expect(normalizeKey('ArrowUp')).toBe('ArrowUp')
    expect(normalizeKey('Enter')).toBe('Enter')
    expect(normalizeKey(' ')).toBe(' ')
  })

  it('leaves non-letter single chars alone (digits, punctuation)', () => {
    expect(normalizeKey('1')).toBe('1')
    expect(normalizeKey('/')).toBe('/')
  })
})

describe('bindingFromEvent', () => {
  it('returns null for modifier-only keystrokes (Shift / Ctrl / Alt / Meta)', () => {
    expect(bindingFromEvent(ev('Shift'))).toBeNull()
    expect(bindingFromEvent(ev('Control', { ctrl: true }))).toBeNull()
    expect(bindingFromEvent(ev('Alt', { alt: true }))).toBeNull()
    expect(bindingFromEvent(ev('Meta', { meta: true }))).toBeNull()
  })

  it('returns null for Dead / Unidentified keys (IME / hardware noise)', () => {
    expect(bindingFromEvent(ev('Dead'))).toBeNull()
    expect(bindingFromEvent(ev('Unidentified'))).toBeNull()
  })

  it('captures plain letter keys lowercased', () => {
    expect(bindingFromEvent(ev('A'))).toEqual({ key: 'a' })
    expect(bindingFromEvent(ev('z'))).toEqual({ key: 'z' })
  })

  it('captures the active modifier flags (and only those)', () => {
    expect(bindingFromEvent(ev('K', { ctrl: true }))).toEqual({
      ctrl: true,
      key: 'k'
    })
    expect(
      bindingFromEvent(ev('Enter', { ctrl: true, shift: true }))
    ).toEqual({ ctrl: true, shift: true, key: 'Enter' })
  })
})

describe('matchBinding', () => {
  it('matches on key alone when modifiers are absent both sides', () => {
    expect(matchBinding({ key: 'a' }, ev('a'))).toBe(true)
    expect(matchBinding({ key: 'a' }, ev('A'))).toBe(true) // case-insensitive
  })

  it('requires every modifier flag to match exactly (no implicit shift)', () => {
    // Ctrl+K is NOT the same shortcut as Ctrl+Shift+K - that's how
    // we keep nav.search distinct from a future Ctrl+Shift+K binding.
    expect(matchBinding({ ctrl: true, key: 'k' }, ev('k', { ctrl: true }))).toBe(true)
    expect(
      matchBinding({ ctrl: true, key: 'k' }, ev('k', { ctrl: true, shift: true }))
    ).toBe(false)
    expect(matchBinding({ key: 'k' }, ev('k', { ctrl: true }))).toBe(false)
  })

  it('matches arrow / special keys verbatim', () => {
    expect(matchBinding({ key: 'ArrowUp' }, ev('ArrowUp'))).toBe(true)
    expect(matchBinding({ key: 'Escape' }, ev('Escape'))).toBe(true)
    expect(matchBinding({ key: ' ' }, ev(' '))).toBe(true)
  })
})

describe('formatBinding', () => {
  it('joins modifiers + the uppercased key with + on non-Mac', () => {
    // JSDOM userAgent is not Mac, so the non-Mac branch fires.
    expect(formatBinding({ ctrl: true, key: 'k' })).toBe('Ctrl+K')
    expect(formatBinding({ ctrl: true, shift: true, key: 'z' })).toBe(
      'Ctrl+Shift+Z'
    )
  })

  it('pretty-prints arrow + special keys', () => {
    expect(formatBinding({ key: 'ArrowUp' })).toBe('↑')
    expect(formatBinding({ key: ' ' })).toBe('Space')
    expect(formatBinding({ key: 'Escape' })).toBe('Esc')
    expect(formatBinding({ alt: true, key: 'b' })).toBe('Alt+B')
  })

  it('renders a bare letter capitalised + alone', () => {
    expect(formatBinding({ key: 'j' })).toBe('J')
  })
})

describe('isTypingTarget', () => {
  it('returns true for INPUT / TEXTAREA / SELECT', () => {
    const input = document.createElement('input')
    const textarea = document.createElement('textarea')
    const select = document.createElement('select')
    expect(isTypingTarget(input)).toBe(true)
    expect(isTypingTarget(textarea)).toBe(true)
    expect(isTypingTarget(select)).toBe(true)
  })

  // The contenteditable branch (`target.isContentEditable`) is
  // skipped here on purpose - JSDOM doesn't derive
  // `isContentEditable` from the attribute (it always returns
  // `false`), so a positive-case test would actually be testing
  // JSDOM's bug rather than our code. Verified manually in-app:
  // typing in the TipTap composer doesn't fire shortcuts.

  it('returns false for buttons / spans / nulls', () => {
    expect(isTypingTarget(document.createElement('button'))).toBe(false)
    expect(isTypingTarget(document.createElement('span'))).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})

describe('resolveBindings', () => {
  it('returns the registry defaults when there are no overrides', () => {
    const resolved = resolveBindings(undefined)
    // Every action in the registry gets at least one default binding.
    for (const action of ACTION_REGISTRY) {
      expect(resolved[action.id]).toEqual(action.defaults)
    }
  })

  it('overrides per-action without touching the rest', () => {
    const custom: Partial<Record<ActionId, Binding[]>> = {
      'card.toggleComplete': [{ key: 't' }]
    }
    const resolved = resolveBindings(custom)
    expect(resolved['card.toggleComplete']).toEqual([{ key: 't' }])
    // Untouched actions keep their defaults.
    expect(resolved['card.focusNext']).toEqual(
      DEFAULT_BINDINGS['card.focusNext']
    )
  })

  it('respects an explicit empty array (user removed all bindings)', () => {
    // The doc string says explicit `[]` should NOT fall back to defaults
    // - that's how a user opts out of an action entirely.
    const resolved = resolveBindings({ 'nav.search': [] })
    expect(resolved['nav.search']).toEqual([])
  })

  it('ignores unknown action ids in storage (forward-compat)', () => {
    const resolved = resolveBindings({
      'unknown.action': [{ key: 'x' }]
    } as unknown as Partial<Record<ActionId, Binding[]>>)
    expect(
      (resolved as unknown as Record<string, Binding[]>)['unknown.action']
    ).toBeUndefined()
    expect(resolved['nav.search']).toEqual(DEFAULT_BINDINGS['nav.search'])
  })
})

describe('actionFromEvent', () => {
  it('returns the first action whose binding matches the event', () => {
    const bindings = resolveBindings(undefined)
    // nav.search is bound to Ctrl+F / Ctrl+K by default - Ctrl+F should
    // resolve to nav.search.
    expect(actionFromEvent(bindings, ev('f', { ctrl: true }))).toBe(
      'nav.search'
    )
  })

  it('returns null for an unbound keystroke', () => {
    const bindings = resolveBindings(undefined)
    expect(
      actionFromEvent(bindings, ev('q', { ctrl: true, shift: true }))
    ).toBeNull()
  })
})

// The hook glue that the renderer's two dispatcher sites (App.tsx
// for nav.* / edit.*, board.tsx for card.* / list.* / board.newList)
// both call. Pure-logic tests above prove the matcher/formatter; this
// block proves the hook wires those primitives correctly: dispatches
// on match, no-ops outside the registry, skips typing targets,
// removes its listener on unmount.

describe('useShortcutDispatch', () => {
  // Dispatch a real KeyboardEvent at document so the hook's listener
  // hears it; matches what the browser would actually deliver.
  function dispatch(
    key: string,
    mods: Partial<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }> = {},
    target: EventTarget = document.body
  ): boolean {
    const e = new KeyboardEvent('keydown', {
      key,
      ctrlKey: mods.ctrl ?? false,
      altKey: mods.alt ?? false,
      shiftKey: mods.shift ?? false,
      metaKey: mods.meta ?? false,
      bubbles: true,
      cancelable: true
    })
    return target.dispatchEvent(e)
  }

  it('fires the matching action’s handler on keydown', () => {
    const onSearch = vi.fn()
    renderHook(() =>
      useShortcutDispatch(resolveBindings(undefined), {
        'nav.search': onSearch
      })
    )
    // Ctrl+F is one of nav.search's defaults.
    dispatch('f', { ctrl: true })
    expect(onSearch).toHaveBeenCalledTimes(1)
  })

  it('does not fire when the bound action has no handler in the map', () => {
    // No handlers wired → matcher resolves the action, dispatcher
    // finds no handler, nothing happens. (Each call site supplies
    // only the subset it owns - App.tsx vs Board.tsx - so this is
    // the normal case, not an error.)
    const noop = vi.fn()
    renderHook(() =>
      useShortcutDispatch(resolveBindings(undefined), {})
    )
    dispatch('f', { ctrl: true })
    expect(noop).not.toHaveBeenCalled()
  })

  it('does not fire when the event matches no binding', () => {
    const onSearch = vi.fn()
    renderHook(() =>
      useShortcutDispatch(resolveBindings(undefined), {
        'nav.search': onSearch
      })
    )
    // Ctrl+Shift+Q isn't bound to anything.
    dispatch('q', { ctrl: true, shift: true })
    expect(onSearch).not.toHaveBeenCalled()
  })

  it('skips dispatch when the event target is a typing context (text input)', () => {
    // Same gate that lets the user type "c" in a card title without
    // firing list.newCard. Mount, dispatch from an <input>, assert
    // nothing fires.
    const onNewCard = vi.fn()
    renderHook(() =>
      useShortcutDispatch(resolveBindings(undefined), {
        'list.newCard': onNewCard
      })
    )
    const input = document.createElement('input')
    document.body.appendChild(input)
    try {
      dispatch('c', {}, input)
      expect(onNewCard).not.toHaveBeenCalled()
    } finally {
      input.remove()
    }
  })

  it('removes the document listener on unmount (no stale handler firing)', () => {
    const onSearch = vi.fn()
    const { unmount } = renderHook(() =>
      useShortcutDispatch(resolveBindings(undefined), {
        'nav.search': onSearch
      })
    )
    unmount()
    dispatch('f', { ctrl: true })
    expect(onSearch).not.toHaveBeenCalled()
  })

  it('honours user overrides over the registry defaults', () => {
    // User remaps nav.search away from Ctrl+F to Ctrl+P. The default
    // binding should NOT fire anymore; the override should.
    const onSearch = vi.fn()
    renderHook(() =>
      useShortcutDispatch(
        resolveBindings({ 'nav.search': [{ ctrl: true, key: 'p' }] }),
        { 'nav.search': onSearch }
      )
    )
    dispatch('f', { ctrl: true })
    expect(onSearch).not.toHaveBeenCalled()
    dispatch('p', { ctrl: true })
    expect(onSearch).toHaveBeenCalledTimes(1)
  })

  it('respects every default binding for the same action (alias bindings)', () => {
    // edit.redo's defaults include Ctrl+Y AND Ctrl+Shift+Z. Both
    // should resolve to the same handler - that's the contract the
    // undo-redo.spec.ts E2E relies on.
    const onRedo = vi.fn()
    renderHook(() =>
      useShortcutDispatch(resolveBindings(undefined), {
        'edit.redo': onRedo
      })
    )
    dispatch('y', { ctrl: true })
    dispatch('z', { ctrl: true, shift: true })
    expect(onRedo).toHaveBeenCalledTimes(2)
  })
})
