import { useEffect } from 'react'

// ADR-0035 · keyboard-shortcut registry + matcher.
//
// Single source of truth for what the keyboard can do on a board view
// and which keystroke(s) trigger each action. The renderer is the
// owner - handlers live next to the components they act on (board.tsx,
// App.tsx) and use this module purely as the action ↔ binding lookup.
//
// Why renderer-side (not Electron `before-input-event`): every action
// here is React-state-driven (focused card, current list, open
// modal) and lives one window-scope away from the keyboard event.
// Main-process bindings would need an IPC ping per action for no win
// on a single-window offline app - see ADR-0035 for the discussion.
//
// Binding model: objects (not strings) so the matcher / formatter
// never has to parse anything at runtime. Stored in localStorage as
// part of `kanbini.settings.shortcuts`; defaults below merge at
// read time so adding a new action lights up automatically.

/** One key-combo. `key` is `KeyboardEvent.key`-shaped (case-insensitive
 *  for letters; canonical names for special keys - `ArrowUp`, `Enter`,
 *  ` ` (Space), `Delete`, `Escape`, etc.). Modifier flags are
 *  independent - a binding with no flags only matches the bare key. */
export interface Binding {
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  meta?: boolean
  /** Single key. Stored lowercase for letters (a–z); special keys keep
   *  their KeyboardEvent.key spelling. Space stored as `' '`. */
  key: string
}

/** Every action the keyboard can fire. Add new ones here + a default
 *  binding + a handler at the use site. The id is the localStorage
 *  key so changing it would orphan user customizations. */
export type ActionId =
  // Card focus navigation (within a list / across lists)
  | 'card.focusNext'
  | 'card.focusPrev'
  | 'card.focusLeft'
  | 'card.focusRight'
  // Card actions (operate on the focused card)
  | 'card.open'
  | 'card.toggleSelect'
  | 'card.toggleComplete'
  | 'card.delete'
  | 'card.moveUp'
  | 'card.moveDown'
  | 'card.moveLeft'
  | 'card.moveRight'
  // Creation
  | 'list.newCard'
  | 'board.newList'
  // Navigation surfaces (the search palette and back-to-home already
  // exist; included here so the user can re-bind them like the rest).
  | 'nav.search'
  | 'nav.home'
  // Undo / redo (ADR-0036)
  | 'edit.undo'
  | 'edit.redo'

export interface ActionDef {
  id: ActionId
  /** Shown in Settings → Shortcuts. */
  label: string
  /** Grouped under this header in the Settings UI. */
  group: 'Navigation' | 'Card' | 'Creation' | 'App'
  /** Pre-customization defaults - also what "Reset to default" goes
   *  back to. */
  defaults: Binding[]
}

const k = (key: string, mods: Partial<Binding> = {}): Binding => ({
  ...mods,
  key
})

export const ACTION_REGISTRY: readonly ActionDef[] = [
  // -- Navigation --
  {
    id: 'card.focusNext',
    label: 'Focus next card in list',
    group: 'Navigation',
    defaults: [k('ArrowDown'), k('j')]
  },
  {
    id: 'card.focusPrev',
    label: 'Focus previous card in list',
    group: 'Navigation',
    defaults: [k('ArrowUp'), k('k')]
  },
  {
    id: 'card.focusLeft',
    label: 'Focus card in previous list',
    group: 'Navigation',
    defaults: [k('ArrowLeft'), k('h')]
  },
  {
    id: 'card.focusRight',
    label: 'Focus card in next list',
    group: 'Navigation',
    defaults: [k('ArrowRight'), k('l')]
  },

  // -- Card --
  {
    id: 'card.open',
    label: 'Open focused card',
    group: 'Card',
    defaults: [k('Enter'), k('o')]
  },
  {
    id: 'card.toggleSelect',
    label: 'Select / deselect focused card (multi-select)',
    group: 'Card',
    defaults: [k('x')]
  },
  {
    id: 'card.toggleComplete',
    label: 'Toggle complete on focused card',
    group: 'Card',
    defaults: [k(' ')]
  },
  {
    id: 'card.delete',
    label: 'Delete focused card',
    group: 'Card',
    defaults: [k('Delete'), k('Backspace', { shift: true })]
  },
  {
    id: 'card.moveUp',
    label: 'Move focused card up in its list',
    group: 'Card',
    defaults: [k('ArrowUp', { alt: true })]
  },
  {
    id: 'card.moveDown',
    label: 'Move focused card down in its list',
    group: 'Card',
    defaults: [k('ArrowDown', { alt: true })]
  },
  {
    id: 'card.moveLeft',
    label: 'Move focused card to previous list',
    group: 'Card',
    defaults: [k('ArrowLeft', { alt: true })]
  },
  {
    id: 'card.moveRight',
    label: 'Move focused card to next list',
    group: 'Card',
    defaults: [k('ArrowRight', { alt: true })]
  },

  // -- Creation --
  {
    id: 'list.newCard',
    label: 'Add a card to the focused list',
    group: 'Creation',
    defaults: [k('c'), k('n')]
  },
  {
    id: 'board.newList',
    label: 'Add a new list',
    group: 'Creation',
    defaults: [k('L', { shift: true })]
  },

  // -- App --
  {
    id: 'nav.search',
    label: 'Open the search palette',
    group: 'App',
    // Both ctrl- and meta-variants - exact-modifier matching means a
    // single Ctrl-binding wouldn't fire on macOS where the muscle
    // memory is Cmd+F. Four defaults look noisy in Settings but each
    // is distinct + independently editable.
    defaults: [
      k('f', { ctrl: true }),
      k('f', { meta: true }),
      k('k', { ctrl: true }),
      k('k', { meta: true })
    ]
  },
  {
    id: 'nav.home',
    label: 'Back to boards home',
    group: 'App',
    // Escape (already wired in App.tsx as a back nav) is intentionally
    // NOT listed here - it's modal-aware in a way the generic matcher
    // would clobber.
    defaults: [k('b', { alt: true })]
  },
  // -- Undo / Redo (ADR-0036) --
  {
    id: 'edit.undo',
    label: 'Undo last action',
    group: 'App',
    defaults: [k('z', { ctrl: true }), k('z', { meta: true })]
  },
  {
    id: 'edit.redo',
    label: 'Redo last undone action',
    group: 'App',
    // Two common conventions: Ctrl+Y (Windows/Linux) AND Ctrl+Shift+Z
    // (the macOS convention; also bound on other platforms by many
    // apps). Both ctrl and meta variants.
    defaults: [
      k('y', { ctrl: true }),
      k('y', { meta: true }),
      k('z', { ctrl: true, shift: true }),
      k('z', { meta: true, shift: true })
    ]
  }
] as const

/** Map id → defaults for O(1) lookup. */
export const DEFAULT_BINDINGS: Record<ActionId, Binding[]> = Object.freeze(
  Object.fromEntries(
    ACTION_REGISTRY.map((a) => [a.id, a.defaults])
  ) as Record<ActionId, Binding[]>
)

/** Normalize a key string for comparison. Letters → lowercase (so the
 *  user pressing Shift+A still matches a binding stored as 'a' when
 *  the shift modifier matters separately); special keys preserved. */
export function normalizeKey(key: string): string {
  if (key.length === 1 && /[a-zA-Z]/.test(key)) return key.toLowerCase()
  return key
}

/** Build a Binding from a keydown event. Returns null for events that
 *  shouldn't be recorded (modifier-only keypress, dead keys). */
export function bindingFromEvent(e: KeyboardEvent): Binding | null {
  const key = e.key
  if (
    key === 'Shift' ||
    key === 'Control' ||
    key === 'Alt' ||
    key === 'Meta' ||
    key === 'Dead' ||
    key === 'Unidentified'
  ) {
    return null
  }
  return {
    ...(e.ctrlKey ? { ctrl: true } : {}),
    ...(e.altKey ? { alt: true } : {}),
    ...(e.shiftKey ? { shift: true } : {}),
    ...(e.metaKey ? { meta: true } : {}),
    key: normalizeKey(key)
  }
}

/** Does this event match the given binding? Modifier flags are exact
 *  (a binding without `shift` will NOT match a Shift+key event), so
 *  Ctrl+K and Ctrl+Shift+K stay distinct. Letter-key comparison is
 *  case-insensitive (Shift+A is the same key as A, the modifier
 *  carries the case info). */
export function matchBinding(binding: Binding, e: KeyboardEvent): boolean {
  if (Boolean(binding.ctrl) !== e.ctrlKey) return false
  if (Boolean(binding.alt) !== e.altKey) return false
  if (Boolean(binding.shift) !== e.shiftKey) return false
  if (Boolean(binding.meta) !== e.metaKey) return false
  return normalizeKey(binding.key) === normalizeKey(e.key)
}

/** Human-readable label for the Settings UI + tooltips. Uses ⌘ on
 *  macOS for the meta modifier; everywhere else it's spelled out so
 *  Linux + Windows users see what they expect. Special keys get
 *  pretty names (Space, ↑, Enter…). */
const IS_MAC =
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent)

const PRETTY_KEY: Record<string, string> = {
  ' ': 'Space',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: 'Enter',
  Escape: 'Esc',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Tab: 'Tab'
}

export function formatBinding(binding: Binding): string {
  const parts: string[] = []
  if (binding.ctrl) parts.push(IS_MAC ? '⌃' : 'Ctrl')
  if (binding.alt) parts.push(IS_MAC ? '⌥' : 'Alt')
  if (binding.shift) parts.push(IS_MAC ? '⇧' : 'Shift')
  if (binding.meta) parts.push(IS_MAC ? '⌘' : 'Meta')
  const key =
    PRETTY_KEY[binding.key] ??
    (binding.key.length === 1 ? binding.key.toUpperCase() : binding.key)
  parts.push(key)
  return parts.join(IS_MAC ? '' : '+')
}

/** Skip the matcher entirely when focus is in a text field or
 *  contenteditable - so typing "c" in a card title doesn't fire the
 *  "new card" shortcut. The handler in board.tsx calls this before
 *  dispatching. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable) return true
  return false
}

/** Merge user customizations over the registry defaults. Unknown ids
 *  in storage are ignored; missing ids fall back to defaults so new
 *  actions added in a build light up without the user touching their
 *  saved blob. */
export function resolveBindings(
  overrides: Partial<Record<ActionId, Binding[]>> | undefined
): Record<ActionId, Binding[]> {
  const out: Record<ActionId, Binding[]> = { ...DEFAULT_BINDINGS }
  if (!overrides) return out
  for (const action of ACTION_REGISTRY) {
    const set = overrides[action.id]
    if (Array.isArray(set)) out[action.id] = set
  }
  return out
}

/** Map an event to an actionId by matching against the user's
 *  resolved bindings. Returns the first action whose binding set
 *  contains the matching combo. */
export function actionFromEvent(
  bindings: Record<ActionId, Binding[]>,
  e: KeyboardEvent
): ActionId | null {
  for (const id of Object.keys(bindings) as ActionId[]) {
    for (const b of bindings[id]) {
      if (matchBinding(b, e)) return id
    }
  }
  return null
}

/** Subscribe to keydown at document level and dispatch the matching
 *  action's handler if one is provided. Handlers map is sparse - only
 *  actions you actually own get a handler; everything else is a
 *  no-op pass-through (someone else's hook can still catch it). Skips
 *  events from text inputs / contenteditable so typing in a card
 *  title doesn't fire shortcuts. */
export function useShortcutDispatch(
  bindings: Record<ActionId, Binding[]>,
  handlers: Partial<Record<ActionId, (e: KeyboardEvent) => void>>
): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isTypingTarget(e.target)) return
      const id = actionFromEvent(bindings, e)
      if (!id) return
      const handler = handlers[id]
      if (!handler) return
      // The handler decides whether to preventDefault - most do.
      handler(e)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [bindings, handlers])
}
