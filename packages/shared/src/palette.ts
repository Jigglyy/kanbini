// The accent swatches lists, labels, and boards are coloured with,
// NAMED so non-UI callers can ask for "red" instead of an oklch string.
//
// Lives in shared (not the renderer) so there is exactly one copy:
//   - the renderer's pickers read the values (`ACCENTS` in
//     apps/renderer/src/lib/palette.ts is derived from this),
//   - the MCP server resolves a name an AI passes ("blue") to the exact
//     stored string, so an AI-made label lands ON a picker swatch
//     instead of as an orphan colour the picker has to special-case.
// A hand-synced copy has already drifted once (the Trello importer's
// map), which is the argument for one source.
//
// Design notes (vivid categorical rainbow in OKLCH, deliberately a
// different colour world from the muted priority ramp) live with the
// renderer helpers that consume these. Re-tuning a value never migrates
// data: stored rows keep the string they were saved with, and the
// pickers surface an off-palette colour via `swatchOptions`.

export const ACCENT_PALETTE = [
  { name: 'red', value: 'oklch(0.63 0.19 25)' },
  // Orange: brighter + more saturated than the muted ochre `medium`
  // priority (oklch(0.66 0.12 70)) so a label bar and a priority flag
  // never read as the same colour.
  { name: 'orange', value: 'oklch(0.72 0.19 48)' },
  { name: 'amber', value: 'oklch(0.76 0.14 85)' },
  { name: 'yellow', value: 'oklch(0.84 0.15 105)' },
  { name: 'lime', value: 'oklch(0.74 0.17 140)' },
  { name: 'green', value: 'oklch(0.64 0.15 160)' },
  { name: 'teal', value: 'oklch(0.68 0.10 195)' },
  { name: 'cyan', value: 'oklch(0.74 0.12 210)' },
  { name: 'sky', value: 'oklch(0.69 0.13 230)' },
  { name: 'blue', value: 'oklch(0.60 0.16 262)' },
  { name: 'indigo', value: 'oklch(0.56 0.17 292)' },
  { name: 'purple', value: 'oklch(0.62 0.18 322)' },
  { name: 'pink', value: 'oklch(0.67 0.20 352)' },
  { name: 'rose', value: 'oklch(0.66 0.19 8)' }
] as const

export type AccentName = (typeof ACCENT_PALETTE)[number]['name']
export type AccentValue = (typeof ACCENT_PALETTE)[number]['value']

/** Palette names in picker order - handy for a zod enum or a tool
 *  description. */
export const ACCENT_NAMES = ACCENT_PALETTE.map(
  (s) => s.name
) as unknown as readonly [AccentName, ...AccentName[]]

/** Palette values in picker order. Typed as a non-empty tuple so
 *  `ACCENT_VALUES[0]` is a colour, not `string | undefined`, under
 *  `noUncheckedIndexedAccess` (the renderer seeds pickers with it). */
export const ACCENT_VALUES = ACCENT_PALETTE.map(
  (s) => s.value
) as unknown as readonly [AccentValue, ...AccentValue[]]

/** Turn a caller-supplied colour into the string to store. A palette
 *  name (case-insensitive, surrounding whitespace ignored) maps to its
 *  exact swatch value; anything else is passed through trimmed as a
 *  raw CSS colour, so a caller can reuse a colour it read back off an
 *  existing entity. Validation of the raw form (length) stays with the
 *  mutation schema - this only translates names. */
export function resolveAccentColor(input: string): string {
  const key = input.trim().toLowerCase()
  const hit = ACCENT_PALETTE.find((s) => s.name === key)
  return hit ? hit.value : input.trim()
}

/** Reverse lookup for display: the palette name for a stored colour, or
 *  null when it's off-palette (a legacy value, or a raw CSS colour). */
export function accentNameOf(value: string | null | undefined): AccentName | null {
  if (!value) return null
  return ACCENT_PALETTE.find((s) => s.value === value)?.name ?? null
}
