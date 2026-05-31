// Single source for the accent swatches used by lists, labels, and
// boards (the home-picker colour picker).
//
// OKLCH on purpose: a categorical rainbow spread evenly around the hue
// wheel so a user has plenty of distinct label/list/board colours to
// pick from. Lightness + chroma vary per hue (yellow has to sit lighter
// than indigo to read as yellow), but every swatch is tuned to stay
// legible on the dark surface and to pair with a readable text colour
// via `accentText`. Surfaces tint *toward* the theme background (see
// board.tsx color-mix), which keeps a coloured list and its cards
// reading as one hue family instead of clashing.
//
// Deliberately a DIFFERENT colour world from the priority ramp in
// `priority.tsx`: these are vivid categorical tags, priorities are a
// muted cool-to-hot severity scale, so a label and a priority on the
// same card never read as "the same colour" (they used to literally
// share oklch strings - low == slate, medium == amber - which was the
// confusing bit).
//
// Values are plain CSS colours; storing them as-is keeps the DB simple.
// When themes land this array (and the --color-* tokens) is the only
// thing that changes. Existing rows keep whatever colour string they
// were saved with, so reordering / re-tuning this list never migrates
// data - it only changes what the picker offers.
/** Readable text colour on an accent background (light accents → dark
 *  text). Falls back to white for non-oklch (legacy) values. */
export function accentText(color: string): string {
  const m = /oklch\(\s*([0-9.]+)/.exec(color)
  const l = m ? parseFloat(m[1]!) : 0
  return l >= 0.66 ? 'oklch(0.20 0 0)' : '#ffffff'
}

/** color-mix in oklab - perceptually clean tint of an accent toward a
 *  theme token (e.g. `tint('oklch(0.62 0.15 250)', 45,
 *  'var(--color-background)')`). Used by lists, the board-view header,
 *  and the home-picker board cards so coloured surfaces stay readable
 *  against the dark theme. */
export function tint(color: string, pct: number, base: string): string {
  return `color-mix(in oklab, ${color} ${pct}%, ${base})`
}

export const ACCENTS = [
  'oklch(0.63 0.19 25)', // red
  // Orange: brighter + more saturated than the muted ochre `medium`
  // priority (oklch(0.66 0.12 70)) so a label bar and a priority flag
  // never read as the same colour. Priorities stay deliberately muted;
  // labels are the vivid set, and this one leans into that.
  'oklch(0.72 0.19 48)', // orange
  'oklch(0.76 0.14 85)', // amber
  'oklch(0.84 0.15 105)', // yellow
  'oklch(0.74 0.17 140)', // lime
  'oklch(0.64 0.15 160)', // green
  'oklch(0.68 0.10 195)', // teal
  'oklch(0.74 0.12 210)', // cyan
  'oklch(0.69 0.13 230)', // sky
  'oklch(0.60 0.16 262)', // blue
  'oklch(0.56 0.17 292)', // indigo
  'oklch(0.62 0.18 322)', // purple
  'oklch(0.67 0.20 352)', // pink
  'oklch(0.66 0.19 8)' // rose
] as const

/** Swatch list for a colour picker on an entity (label / list / board)
 *  that may already carry a colour. If `current` is a non-null colour
 *  that ISN'T one of the standard `ACCENTS` - e.g. a label saved under
 *  an older palette before this one was re-tuned - it's prepended so
 *  the picker still shows it AND highlights it as selected, instead of
 *  rendering with nothing selected (which read as "the colour no longer
 *  exists"). Picking any standard swatch then heals it back onto the
 *  palette. Returns the bare `ACCENTS` when `current` is null/standard,
 *  so callers never get a duplicate swatch. */
export function swatchOptions(
  current: string | null | undefined
): readonly string[] {
  if (current && !(ACCENTS as readonly string[]).includes(current)) {
    return [current, ...ACCENTS]
  }
  return ACCENTS
}

// ADR-0034 · gradient presets for board backgrounds. The DB stores
// only the key (e.g. `sunset`); the renderer resolves it to a CSS
// gradient string here. Keeping the palette in code (not in the DB)
// means we can re-tint these later without a migration. Hues borrow
// from the ACCENTS family so a board's accent + gradient sit in the
// same colour world.
//
// Tuned to read well behind the kanban lists: medium chroma + enough
// lightness contrast for cards/lists to pop without overwhelming the
// content. All linear-gradient (gentlest), top-left → bottom-right.
export interface GradientPreset {
  key: string
  label: string
  css: string
}

export const GRADIENT_PRESETS: readonly GradientPreset[] = [
  {
    key: 'sunset',
    label: 'Sunset',
    css: 'linear-gradient(135deg, oklch(0.70 0.18 30) 0%, oklch(0.55 0.20 350) 100%)'
  },
  {
    key: 'ocean',
    label: 'Ocean',
    css: 'linear-gradient(135deg, oklch(0.55 0.18 220) 0%, oklch(0.45 0.15 260) 100%)'
  },
  {
    key: 'forest',
    label: 'Forest',
    css: 'linear-gradient(135deg, oklch(0.50 0.13 145) 0%, oklch(0.35 0.10 170) 100%)'
  },
  {
    key: 'dusk',
    label: 'Dusk',
    css: 'linear-gradient(135deg, oklch(0.45 0.10 280) 0%, oklch(0.30 0.08 310) 100%)'
  },
  {
    key: 'meadow',
    label: 'Meadow',
    css: 'linear-gradient(135deg, oklch(0.75 0.14 120) 0%, oklch(0.55 0.18 80) 100%)'
  },
  {
    key: 'rose',
    label: 'Rose',
    css: 'linear-gradient(135deg, oklch(0.75 0.14 20) 0%, oklch(0.55 0.18 350) 100%)'
  },
  {
    key: 'graphite',
    label: 'Graphite',
    css: 'linear-gradient(135deg, oklch(0.30 0.02 250) 0%, oklch(0.20 0.02 250) 100%)'
  }
] as const

/** Look a gradient up by stored key. Returns null for unknown keys so
 *  callers fall back gracefully (the renderer treats null background
 *  as "no background"). */
export function gradientCss(key: string): string | null {
  return GRADIENT_PRESETS.find((g) => g.key === key)?.css ?? null
}

/** Resolve a BoardBackground (or null) into the bits a CSS `style`
 *  prop needs: `image` is what goes into `background` / `background-
 *  image`, `color` is the fallback solid colour (or null). Used by the
 *  home-picker card preview and the board-view `<main>` wrapper. ADR-
 *  0034 keeps the source of truth (color / preset key / relPath) in
 *  the DB; this is the one place the renderer turns it into CSS. */
export function backgroundCss(
  bg: { kind: 'color'; value: string }
    | { kind: 'gradient'; preset: string }
    | { kind: 'image'; relPath: string }
    | null
): { image: string | null; color: string | null } {
  if (!bg) return { image: null, color: null }
  if (bg.kind === 'color') return { image: null, color: bg.value }
  if (bg.kind === 'gradient') return { image: gradientCss(bg.preset), color: null }
  // image - serve via the kanbini-file:// scheme; encode each segment
  // so spaces / non-ascii in filenames survive the URL boundary.
  const encoded = bg.relPath.split('/').map(encodeURIComponent).join('/')
  return { image: `url("kanbini-file://${encoded}")`, color: null }
}
