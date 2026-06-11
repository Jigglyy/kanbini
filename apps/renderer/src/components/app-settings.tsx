import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  ChevronLeft,
  Copy,
  Download,
  Eye,
  EyeOff,
  Plus,
  RotateCcw,
  Upload,
  X
} from 'lucide-react'
import {
  APP_CODENAME,
  type ExportSummary,
  type ImportSummary
} from '@kanbini/shared'
// Brand mark - see App.tsx import. Same source asset.
import brandLogo from '../assets/logo.png'
import { ipc } from '../lib/ipc'
import type { Settings, StartMode, Theme } from '../lib/settings'
import {
  ACTION_REGISTRY,
  DEFAULT_BINDINGS,
  bindingFromEvent,
  formatBinding,
  type ActionId,
  type Binding
} from '../lib/shortcuts'
import { cn } from '../lib/utils'
import { TemplatesManager } from './templates'

// Show the platform-correct modifier in the mouse-controls help (Cmd on
// macOS, Ctrl elsewhere) - same check App.tsx uses for the search chip.
const IS_MAC =
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent)

// M4-F settings screen. Replaces the M4-G+ modal - the surface grew
// large enough (Appearance / Startup / Cards / Data / Link previews /
// MCP / About) that a left-sidebar layout works better than a single
// scrolling panel. App.tsx renders this in the main scroll container
// in place of the home picker / board view.
//
// The active section is local state so deep-linking is intentionally
// out of scope - the only entry point is the header gear, which always
// lands on the first section. Switching sections never leaves this
// screen; only the back button returns to the previous route.

type SettingsSection =
  | 'appearance'
  | 'startup'
  | 'cards'
  | 'shortcuts'
  | 'data'
  | 'templates'
  | 'linkPreviews'
  | 'obsidian'
  | 'mcp'
  | 'about'

interface SectionDef {
  id: SettingsSection
  label: string
}

interface SectionGroup {
  /** Group header - inert label rendered above the rows. Null = no
   *  header (the trailing "About" group sits on its own without a
   *  redundant "About" header above an "About" row). */
  header: string | null
  sections: SectionDef[]
}

// Sidebar grouping. The list grew to 10 leaf entries in M4 → ADR-0044
// and was reading as a chronological log of which ADR shipped when.
// Groups put related controls together so a first-time user can scan
// the sidebar instead of memorising it. Headers are inert (not
// clickable, no collapse - the full list still fits in the viewport
// without scrolling on a normal display).
//
// The grouping narrative, top-down:
//   1. Personalize  - how the app looks + how you interact with it
//   2. Boards & cards - defaults that shape the work surface itself
//   3. Connections  - every opt-in path to *something else*: link
//                     previews touch the network, Obsidian writes
//                     to a vault, AI integration opens a loopback
//                     channel. Controllable from one roof so the
//                     user can audit external touchpoints in one
//                     place.
//   4. (no header)  - utility rows that don't fit a theme: backup
//                     (your own data, exported to disk you choose)
//                     and About (meta / runtime / paths).
//
// `SettingsSection` ids (`'data'`, `'mcp'`) are unchanged so the
// persisted `kanbini.lastSettingsSection` survives the regrouping;
// only the user-visible labels move. "Data" → "Backup & restore"
// because the parent grouping was redundant with the leaf name, and
// "Backup & restore" describes the actual primary action. "MCP" →
// "AI integration" - same phrase the in-section header uses, and
// less jargon for a first-time user.
const SECTION_GROUPS: SectionGroup[] = [
  {
    header: 'Personalize',
    sections: [
      { id: 'appearance', label: 'Appearance' },
      { id: 'shortcuts', label: 'Shortcuts' }
    ]
  },
  {
    header: 'Boards & cards',
    sections: [
      { id: 'startup', label: 'Startup' },
      { id: 'cards', label: 'Cards' },
      { id: 'templates', label: 'Templates' }
    ]
  },
  {
    header: 'Connections',
    sections: [
      { id: 'linkPreviews', label: 'Link previews' },
      { id: 'obsidian', label: 'Obsidian' },
      { id: 'mcp', label: 'AI integration' }
    ]
  },
  {
    header: null,
    sections: [
      { id: 'data', label: 'Backup & restore' },
      { id: 'about', label: 'About' }
    ]
  }
]

// Flat lookup for the "is this a known section?" check on the
// persisted last-section. Keeps the SettingsSection union the single
// source of truth - derived from SECTION_GROUPS so adding a section
// in one place keeps this in sync automatically.
const ALL_SECTIONS: SectionDef[] = SECTION_GROUPS.flatMap(
  (g) => g.sections
)

// Persist the active section across open/close so reopening Settings
// lands the user back where they were. Same pattern as
// `kanbini.boardsHomeSort` / `kanbini.expandedChecklists` - a tiny
// per-feature localStorage key rather than the bigger
// `kanbini.settings` blob (this is UI state, not a user preference).
// Falls back to 'appearance' for a missing / corrupt / now-removed
// section.
const SECTION_STORAGE_KEY = 'kanbini.lastSettingsSection'

function loadInitialSection(): SettingsSection {
  try {
    const raw = localStorage.getItem(SECTION_STORAGE_KEY)
    if (raw && ALL_SECTIONS.some((s) => s.id === raw)) {
      return raw as SettingsSection
    }
  } catch {
    /* fall through */
  }
  return 'appearance'
}

interface Props {
  onClose: () => void
  settings: Settings
  update: (patch: Partial<Settings>) => void
}

export function AppSettings({ onClose, settings, update }: Props) {
  const [section, setSection] = useState<SettingsSection>(loadInitialSection)
  // Persist on every change. Idempotent; cheap.
  useEffect(() => {
    try {
      localStorage.setItem(SECTION_STORAGE_KEY, section)
    } catch {
      /* full disk / private mode - the section just won't restore */
    }
  }, [section])

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <header className="flex items-center gap-3">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronLeft className="size-4" />
          Back
        </button>
        <h2 className="text-xl font-semibold tracking-tight">Settings</h2>
      </header>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-[12rem_1fr]">
        {/* On narrow screens the sidebar flattens to a horizontal
            scroller and group headers are pointless noise - render the
            inert headers only when stacked as a sidebar (md+). */}
        <nav className="flex flex-row gap-1 overflow-x-auto md:flex-col md:gap-0.5">
          {SECTION_GROUPS.map((group, gi) => (
            <div
              key={group.header ?? `group-${gi}`}
              className={cn(
                'contents md:flex md:flex-col md:gap-0.5',
                // Header-less groups (the utility tail - backup,
                // about) need an explicit divider above on md+ or
                // they read as continuations of the previous group.
                // First group is always flush regardless.
                gi > 0 &&
                  !group.header &&
                  'md:mt-3 md:border-t md:border-border/50 md:pt-3'
              )}
            >
              {group.header && (
                <h4
                  className={cn(
                    'hidden px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 md:block',
                    // First group sits flush with the top of the
                    // sidebar; later ones get breathing room above so
                    // the grouping reads visually.
                    gi === 0 ? 'pt-0 pb-1' : 'pt-3 pb-1'
                  )}
                >
                  {group.header}
                </h4>
              )}
              {group.sections.map((s) => {
                const active = s.id === section
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSection(s.id)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'shrink-0 rounded-md px-3 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active
                        ? 'bg-accent text-foreground'
                        : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                    )}
                  >
                    {s.label}
                  </button>
                )
              })}
            </div>
          ))}
        </nav>

        <div className="flex flex-col gap-6">
          {section === 'appearance' && (
            <AppearanceSection settings={settings} update={update} />
          )}
          {section === 'startup' && (
            <StartupSection settings={settings} update={update} />
          )}
          {section === 'cards' && (
            <CardsSection settings={settings} update={update} />
          )}
          {section === 'shortcuts' && (
            <ShortcutsSection settings={settings} update={update} />
          )}
          {section === 'data' && (
            <DataSection settings={settings} update={update} />
          )}
          {section === 'templates' && <TemplatesSection />}
          {section === 'linkPreviews' && (
            <LinkPreviewsSection settings={settings} update={update} />
          )}
          {section === 'obsidian' && (
            <ObsidianSection settings={settings} update={update} />
          )}
          {section === 'mcp' && <McpSection />}
          {section === 'about' && <AboutSection />}
        </div>
      </div>
    </div>
  )
}

function AppearanceSection({
  settings,
  update
}: {
  settings: Settings
  update: (p: Partial<Settings>) => void
}) {
  return (
    <Section title="Appearance">
      <RadioRow<Theme>
        name="theme"
        value={settings.theme}
        options={[
          {
            value: 'system',
            label: 'Match system',
            hint: 'Follow your OS.'
          },
          { value: 'dark', label: 'Dark', hint: 'Always dark.' },
          { value: 'light', label: 'Light', hint: 'Always light.' }
        ]}
        onChange={(v) => update({ theme: v })}
      />
    </Section>
  )
}

function StartupSection({
  settings,
  update
}: {
  settings: Settings
  update: (p: Partial<Settings>) => void
}) {
  return (
    <Section title="Startup">
      <RadioRow<StartMode>
        name="startMode"
        value={settings.startMode}
        options={[
          {
            value: 'home',
            label: 'Boards menu',
            hint: 'Open the boards list.'
          },
          {
            value: 'lastBoard',
            label: 'Last opened board',
            hint: 'Reopen the board you last used.'
          }
        ]}
        onChange={(v) => update({ startMode: v })}
      />
    </Section>
  )
}

function CardsSection({
  settings,
  update
}: {
  settings: Settings
  update: (p: Partial<Settings>) => void
}) {
  return (
    <>
      <Section title="Card limits">
        <ToggleRow
          label="Block new cards when a list is full"
          hint="Hides the add box at the limit."
          checked={settings.cardLimitBlocksCreate}
          onChange={(v) => update({ cardLimitBlocksCreate: v })}
        />
        <ToggleRow
          label="Block dragging cards into a full list"
          hint="Rejects drops onto a full list."
          checked={settings.cardLimitBlocksDrag}
          onChange={(v) => update({ cardLimitBlocksDrag: v })}
        />
      </Section>

      <Section title="Card display">
        <ToggleRow
          label="Show checklists on cards"
          hint="Tick items without opening the card."
          checked={settings.showChecklistOnCard}
          onChange={(v) => update({ showChecklistOnCard: v })}
        />
        <ToggleRow
          label="Show label names on cards"
          hint="Off shows compact colour bars; click one on a card to expand."
          checked={settings.labelsExpanded}
          onChange={(v) => update({ labelsExpanded: v })}
        />
      </Section>
    </>
  )
}

// ADR-0035 · Shortcuts settings. Lists every action in the registry
// grouped by Navigation / Card / Creation / App. Each row shows the
// current bindings as chips (click × to remove a single binding) +
// an "Add" button that opens an inline recorder + a Reset that drops
// the user's override and falls back to the registry default. Empty
// binding array (after removing all) is intentionally distinct from
// "never customized" - it means "don't use defaults, this action has
// no shortcut at all."
function ShortcutsSection({
  settings,
  update
}: {
  settings: Settings
  update: (p: Partial<Settings>) => void
}) {
  /** Resolve effective bindings - overrides win, including the empty-
   *  array "user removed all" state. Missing key → registry default. */
  function effective(id: ActionId): Binding[] {
    const override = settings.shortcuts[id]
    if (Array.isArray(override)) return override
    return DEFAULT_BINDINGS[id]
  }

  function setBindings(id: ActionId, next: Binding[]): void {
    update({ shortcuts: { ...settings.shortcuts, [id]: next } })
  }

  function reset(id: ActionId): void {
    // Strip the override so future default changes ride along; null
    // out the key by re-spreading without it.
    const { [id]: _drop, ...rest } = settings.shortcuts
    void _drop
    update({ shortcuts: rest })
  }

  function bindingExists(list: Binding[], b: Binding): boolean {
    return list.some(
      (x) =>
        Boolean(x.ctrl) === Boolean(b.ctrl) &&
        Boolean(x.alt) === Boolean(b.alt) &&
        Boolean(x.shift) === Boolean(b.shift) &&
        Boolean(x.meta) === Boolean(b.meta) &&
        x.key.toLowerCase() === b.key.toLowerCase()
    )
  }

  // Group actions by their `group` field for the visual sections.
  const groups: Array<ActionId[]> = []
  for (const def of ACTION_REGISTRY) {
    const last = groups.at(-1)
    if (
      last &&
      ACTION_REGISTRY.find((a) => a.id === last[0]!)?.group === def.group
    ) {
      last.push(def.id)
    } else {
      groups.push([def.id])
    }
  }

  return (
    <>
      <p className="px-1 text-xs text-muted-foreground">
        Add multiple shortcuts per action. Click Add to record one,
        × to remove one, Reset for the defaults.
      </p>
      <Section title="Mouse">
        <div className="flex items-center justify-between gap-3 px-1 py-1.5 text-sm">
          <span>Open a card</span>
          <span className="text-muted-foreground">Click</span>
        </div>
        <div className="flex items-center justify-between gap-3 px-1 py-1.5 text-sm">
          <span>Select / deselect a card (multi-select)</span>
          <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-xs">
            {IS_MAC ? 'Cmd' : 'Ctrl'} + Click
          </kbd>
        </div>
        <div className="flex items-center justify-between gap-3 px-1 py-1.5 text-sm">
          <span>Select a range of cards in a list</span>
          <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-xs">
            Shift + Click
          </kbd>
        </div>
      </Section>
      {groups.map((ids) => {
        const groupLabel = ACTION_REGISTRY.find((a) => a.id === ids[0]!)
          ?.group
        return (
          <Section key={groupLabel} title={groupLabel ?? 'Other'}>
            {ids.map((id) => {
              const def = ACTION_REGISTRY.find((a) => a.id === id)!
              const bindings = effective(id)
              const overridden = Array.isArray(settings.shortcuts[id])
              return (
                <ShortcutRow
                  key={id}
                  label={def.label}
                  bindings={bindings}
                  overridden={overridden}
                  onAdd={(b) => {
                    if (bindingExists(bindings, b)) return
                    setBindings(id, [...bindings, b])
                  }}
                  onRemove={(idx) =>
                    setBindings(
                      id,
                      bindings.filter((_, i) => i !== idx)
                    )
                  }
                  onReset={() => reset(id)}
                />
              )
            })}
          </Section>
        )
      })}
    </>
  )
}

function ShortcutRow({
  label,
  bindings,
  overridden,
  onAdd,
  onRemove,
  onReset
}: {
  label: string
  bindings: Binding[]
  /** True when the user has customized this action - Reset enabled
   *  only in that case so a casual user can tell which actions they've
   *  changed at a glance. */
  overridden: boolean
  onAdd: (b: Binding) => void
  onRemove: (index: number) => void
  onReset: () => void
}) {
  const [recording, setRecording] = useState(false)
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3 text-sm">
      <span className="min-w-56 flex-1 font-medium text-foreground">
        {label}
      </span>
      <div className="flex flex-1 flex-wrap items-center gap-1.5">
        {bindings.length === 0 && !recording && (
          <span className="text-xs italic text-muted-foreground">
            (no shortcut)
          </span>
        )}
        {bindings.map((b, i) => (
          <span
            key={`${formatBinding(b)}-${i}`}
            className="inline-flex items-center gap-1 rounded border border-border bg-muted/60 px-1.5 py-0.5 text-xs font-mono"
          >
            {formatBinding(b)}
            <button
              type="button"
              onClick={() => onRemove(i)}
              aria-label={`Remove ${formatBinding(b)}`}
              className="inline-flex size-4 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        {recording ? (
          <BindingRecorder
            onCapture={(b) => {
              onAdd(b)
              setRecording(false)
            }}
            onCancel={() => setRecording(false)}
          />
        ) : (
          <button
            type="button"
            onClick={() => setRecording(true)}
            className="inline-flex items-center gap-1 rounded border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground hover:border-ring hover:text-foreground"
          >
            <Plus className="size-3" />
            Add
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={onReset}
        disabled={!overridden}
        className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      >
        <RotateCcw className="size-3" />
        Reset
      </button>
    </div>
  )
}

/** Captures the next non-modifier keystroke as a Binding. Renders as
 *  a focused box so the global dispatchers skip the event (focused
 *  text-target check) AND so the user has a clear "ready to record"
 *  affordance. Esc cancels without recording. */
function BindingRecorder({
  onCapture,
  onCancel
}: {
  onCapture: (b: Binding) => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  // Auto-focus on mount so the user doesn't have to click first.
  useEffect(() => {
    ref.current?.focus()
  }, [])
  return (
    <div
      ref={ref}
      role="textbox"
      tabIndex={0}
      onBlur={onCancel}
      onKeyDown={(e) => {
        // Always stop propagation so the document-level shortcut
        // dispatcher doesn't fire on the keystroke we're capturing.
        e.stopPropagation()
        e.preventDefault()
        if (e.key === 'Escape') {
          onCancel()
          return
        }
        const b = bindingFromEvent(e.nativeEvent)
        if (b) onCapture(b)
      }}
      className="inline-flex items-center gap-1 rounded border border-ring bg-background px-2 py-0.5 text-xs font-mono text-foreground outline-none ring-2 ring-ring/40"
    >
      Press keys…
    </div>
  )
}

function LinkPreviewsSection({
  settings,
  update
}: {
  settings: Settings
  update: (p: Partial<Settings>) => void
}) {
  return (
    <Section title="Link previews">
      <ToggleRow
        label="Fetch cover previews from URLs"
        hint="Only URLs you paste are ever contacted."
        checked={settings.linkPreviews}
        onChange={(v) => update({ linkPreviews: v })}
      />
      <ToggleRow
        label="Auto cover from URL in title"
        hint="Use the URL's preview as the cover. Existing cards aren't touched."
        checked={settings.autoCoverFromUrl}
        disabled={!settings.linkPreviews}
        onChange={(v) => update({ autoCoverFromUrl: v })}
      />
    </Section>
  )
}

// ADR-0042 - Obsidian one-way push. Sits next to Link previews
// because both are opt-in escape hatches from offline-by-default
// (link previews touch the network; this touches the FS outside
// userData). Vault content is never read for cross-direction sync -
// strictly push.
function ObsidianSection({
  settings,
  update
}: {
  settings: Settings
  update: (p: Partial<Settings>) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<null | {
    written: number
    cardCount: number
    skippedForeign: number
    pruned: number
    warnings: string[]
  }>(null)
  const patchObsidian = (
    patch: Partial<Settings['obsidian']>
  ): void => {
    update({ obsidian: { ...settings.obsidian, ...patch } })
  }
  const pickVault = async (): Promise<void> => {
    setError(null)
    try {
      const picked = await ipc.obsidianPickVault()
      if (picked) patchObsidian({ vaultPath: picked })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const runPush = async (): Promise<void> => {
    if (!settings.obsidian.vaultPath) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const r = await ipc.obsidianPush({
        vaultPath: settings.obsidian.vaultPath,
        subfolder: settings.obsidian.subfolder
      })
      setResult({
        written: r.written,
        cardCount: r.cardCount,
        skippedForeign: r.skippedForeign,
        pruned: r.pruned,
        warnings: r.warnings
      })
      patchObsidian({ lastPush: r.pushedAt })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const canPush =
    settings.obsidian.enabled &&
    !!settings.obsidian.vaultPath &&
    settings.obsidian.subfolder.trim().length > 0

  return (
    <>
      <Section title="Obsidian (one-way push)">
        <ToggleRow
          label="Push cards to an Obsidian vault"
          hint="Push-only. Vault content is never read back."
          checked={settings.obsidian.enabled}
          onChange={(v) => patchObsidian({ enabled: v })}
        />
        <p className="px-1 text-xs text-muted-foreground">
          Sync now writes every card on your active boards (archived
          boards are skipped) as a Markdown note to{' '}
          <code className="rounded bg-muted px-1">
            &lt;vault&gt;/{settings.obsidian.subfolder || 'Kanbini'}/&lt;board&gt;/&lt;title&gt;.md
          </code>
          . Files Kanbini didn't write are left alone. Attachments
          aren't copied.
        </p>
        <p className="rounded-md border border-warning/30 bg-warning/10 px-2 py-1.5 text-xs text-warning">
          <strong>Heads up:</strong> edits you make in Obsidian get
          overwritten on the next sync. Edit cards in Kanbini, read
          and link them in Obsidian.
        </p>
        <div className="flex flex-col gap-2 rounded-md border border-border bg-background p-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Vault folder</span>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 text-foreground/90">
                {settings.obsidian.vaultPath ?? '(not set)'}
              </code>
              <button
                type="button"
                onClick={() => void pickVault()}
                disabled={!settings.obsidian.enabled}
                className="rounded border border-border bg-background px-3 py-1.5 text-sm text-foreground hover:border-ring disabled:cursor-not-allowed disabled:opacity-50"
              >
                Pick…
              </button>
            </div>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Subfolder in vault</span>
            <input
              value={settings.obsidian.subfolder}
              onChange={(e) =>
                patchObsidian({ subfolder: e.target.value })
              }
              disabled={!settings.obsidian.enabled}
              maxLength={256}
              className="rounded border border-border bg-background px-2 py-1.5 text-sm focus:border-ring focus:outline-none disabled:opacity-50"
            />
          </label>
          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="text-xs text-muted-foreground">
              {settings.obsidian.lastPush
                ? `Last push: ${new Date(settings.obsidian.lastPush).toLocaleString()}`
                : 'Never pushed'}
            </span>
            <button
              type="button"
              onClick={() => void runPush()}
              disabled={!canPush || busy}
              className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Pushing…' : 'Sync now'}
            </button>
          </div>
        </div>
        {error && (
          <p className="rounded-md border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">
            {error}
          </p>
        )}
        {result && (
          <div className="rounded-md border border-border bg-background p-3 text-xs">
            <p className="text-foreground">
              Wrote {result.written} of {result.cardCount}{' '}
              {result.cardCount === 1 ? 'card' : 'cards'}.
            </p>
            {result.skippedForeign > 0 && (
              <p className="mt-1 text-muted-foreground">
                Left alone: {result.skippedForeign}{' '}
                {result.skippedForeign === 1 ? 'file' : 'files'} the
                vault already owned.
              </p>
            )}
            {result.pruned > 0 && (
              <p className="mt-1 text-muted-foreground">
                Cleaned up {result.pruned} stale{' '}
                {result.pruned === 1 ? 'note' : 'notes'} from renamed
                or deleted cards.
              </p>
            )}
            {result.warnings.length > 0 && (
              <ul className="mt-2 flex flex-col gap-0.5 text-muted-foreground/80">
                {result.warnings.slice(0, 5).map((w, i) => (
                  <li key={i} className="truncate">
                    {w}
                  </li>
                ))}
                {result.warnings.length > 5 && (
                  <li>… and {result.warnings.length - 5} more</li>
                )}
              </ul>
            )}
          </div>
        )}
      </Section>
    </>
  )
}

// Data section - manual backup (full-DB export) + restore (wipe +
// re-import). Auto-export on app close is silent so this is the
// user-visible side of the same plumbing (ADR-0019). Lived in the
// per-board gear popover from M4-A→M4-G+; M4-F moves it here so the
// per-board popover is rename-only and the data-ownership controls
// have one canonical home.
function DataSection({
  settings,
  update
}: {
  settings: Settings
  update: (p: Partial<Settings>) => void
}) {
  const [exporting, setExporting] = useState(false)
  const [lastExport, setLastExport] = useState<ExportSummary | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [lastImport, setLastImport] = useState<ImportSummary | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  // App-info is cheap + pure - surface the export folder + userData
  // path so the user knows where backups live without digging.
  const { data: info } = useQuery({
    queryKey: ['appInfo'],
    queryFn: () => ipc.appInfo(),
    staleTime: 60_000
  })

  // M5-B / ADR-0049 - keep HKCU in sync with the in-memory toggle.
  // Fires once on Settings mount AND on every toggle change so a
  // user who wiped the registry by hand (or installed over an older
  // version that didn't write the key) gets back to a consistent
  // state without touching the toggle.
  useEffect(() => {
    if (info?.platform !== 'win32') return
    void ipc
      .uninstallSetRemoveDataOnUninstall(settings.removeDataOnUninstall)
      .catch((err) => {
        // Non-fatal - main logs the actual failure. The toggle UI
        // still reflects the user's choice; the registry just
        // didn't update, and at uninstall NSIS will fall back to
        // "leave data" (the missing-key branch).
        console.warn('uninstall-toggle sync failed:', err)
      })
  }, [info?.platform, settings.removeDataOnUninstall])

  const runExport = async (): Promise<void> => {
    setExporting(true)
    setExportError(null)
    try {
      setLastExport(await ipc.exportNow())
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err))
    } finally {
      setExporting(false)
    }
  }

  const runImport = async (): Promise<void> => {
    setImporting(true)
    setImportError(null)
    try {
      const summary = await ipc.importFolder()
      if (summary) setLastImport(summary)
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err))
    } finally {
      setImporting(false)
    }
  }

  return (
    <>
      <Section title="Backup">
        <button
          onClick={() => void runExport()}
          disabled={exporting}
          className="flex items-center gap-2 self-start rounded border border-border bg-background px-3 py-1.5 text-sm text-foreground hover:border-ring disabled:cursor-wait disabled:opacity-60"
        >
          <Download className="size-3.5" />
          {exporting ? 'Exporting…' : 'Export now'}
        </button>
        {lastExport && (
          <span className="text-xs text-muted-foreground">
            {`${lastExport.counts.boards} boards · ${lastExport.counts.cards} cards · ${lastExport.counts.attachments} attachments → ${lastExport.destRoot}`}
          </span>
        )}
        {exportError && (
          <span className="text-xs text-red-400">{exportError}</span>
        )}
        <span className="text-xs text-muted-foreground/70">
          Runs on quit too.
          {info && (
            <>
              {' '}
              Goes to <PathChip path={info.paths.export} />.
            </>
          )}
        </span>
      </Section>

      <Section title="Restore">
        <button
          onClick={() => void runImport()}
          disabled={importing}
          className="flex items-center gap-2 self-start rounded border border-border bg-background px-3 py-1.5 text-sm text-foreground hover:border-ring disabled:cursor-wait disabled:opacity-60"
        >
          <Upload className="size-3.5" />
          {importing ? 'Restoring…' : 'Restore from folder…'}
        </button>
        {lastImport && (
          <span className="text-xs text-muted-foreground">
            {`Restored ${lastImport.counts.cards} cards · ${lastImport.counts.attachmentFilesCopied}/${lastImport.counts.attachments} files`}
          </span>
        )}
        {importError && (
          <span className="text-xs text-red-400">{importError}</span>
        )}
        <span className="text-xs text-warning">
          Wipes everything and replaces it with the chosen folder.
        </span>
      </Section>

      {info && (
        <Section title="Data location">
          <DetailRow label="App data" value={info.paths.userData} />
          <DetailRow label="Database" value={info.paths.db} />
          <DetailRow label="Attachments" value={info.paths.attachments} />
        </Section>
      )}

      {/* M5-B / ADR-0049 - Windows-only opt-in to delete userData on
          uninstall. macOS and Linux app bundles don't run an
          uninstaller script we can hook, so the toggle is hidden
          there (the data lives where the user expects either way:
          ~/Library/Application Support/Kanbini on macOS,
          ~/.config/Kanbini on Linux). */}
      {info?.platform === 'win32' && (
        <Section title="Uninstall">
          <ToggleRow
            label="Remove my data when uninstalling"
            hint="When you uninstall Kanbini, also delete your boards, attachments, and settings. Off by default - uninstalling leaves your data alone so a reinstall picks up where you left off."
            checked={settings.removeDataOnUninstall}
            onChange={(v) => update({ removeDataOnUninstall: v })}
          />
        </Section>
      )}

      <UndoHistorySection />
    </>
  )
}

// ADR-0036 revision · escape hatch for the global+persistent undo log.
// The log can accumulate orphaned create entries when their matching
// deletes are pruned out under the cap (or come from cascades that the
// log doesn't capture). Redoing those orphans resurrects state the
// user thought was gone. Clearing the log is the safe nuclear option.
function UndoHistorySection() {
  const qc = useQueryClient()
  // Status is small + cheap; refetch on the same `changed` event the
  // rest of the renderer listens to so the Clear button enables /
  // disables in lockstep with the actual stack.
  const { data: status } = useQuery({
    queryKey: ['undoStatus'],
    queryFn: () => ipc.undoStatus(),
    staleTime: 1_000
  })
  const [confirming, setConfirming] = useState(false)
  const [clearing, setClearing] = useState(false)
  const onClear = async (): Promise<void> => {
    setClearing(true)
    try {
      await ipc.undoClear()
      await qc.invalidateQueries({ queryKey: ['undoStatus'] })
    } finally {
      setClearing(false)
      setConfirming(false)
    }
  }
  return (
    <Section title="Undo history">
      <p className="px-1 text-xs text-muted-foreground">
        Ctrl+Z and Ctrl+Y replay your undo history. It's shared
        across boards and survives restarts. Clear it if undo starts
        misbehaving.
      </p>
      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={!status?.canUndo && !status?.canRedo}
          className="flex items-center gap-2 self-start rounded border border-border bg-background px-3 py-1.5 text-sm text-foreground hover:border-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RotateCcw className="size-3.5" />
          Clear undo history
        </button>
      ) : (
        <div className="flex flex-col gap-2 self-start rounded border border-border bg-card p-3">
          <span className="text-xs text-foreground">
            Wipes every Ctrl+Z / Ctrl+Y entry. Your boards, lists, and
            cards stay put. Only the history is dropped.
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={clearing}
              className="rounded border border-border bg-background px-3 py-1 text-sm text-foreground hover:border-ring"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void onClear()}
              disabled={clearing}
              className="rounded border border-red-500/40 bg-red-500/10 px-3 py-1 text-sm text-red-300 hover:border-red-500/70 disabled:cursor-wait disabled:opacity-60"
            >
              {clearing ? 'Clearing…' : 'Clear history'}
            </button>
          </div>
        </div>
      )}
    </Section>
  )
}

/** Settings → Templates. ADR-0038 housekeeping home for saved board /
 *  list templates. Saving + instantiating happen on the surfaces where
 *  the user is *doing* the work (board-rename popover, list pencil
 *  menu, boards-home "From template" button, AddList "From template"
 *  affordance) - this section is the rename / delete bookkeeper. */
function TemplatesSection() {
  return (
    <Section title="Templates">
      <p className="px-1 text-xs text-muted-foreground">
        Rename or delete saved templates. To <em>save</em> one, use
        the rename menu on a board or list. To <em>use</em> one, click{' '}
        <em>From template</em> on the boards home or in{' '}
        <em>+ Add a list</em>.
      </p>
      <TemplatesManager />
    </Section>
  )
}

/** Inline file-path chip - selectable text so the user can copy it
 *  without us needing a clipboard button on every row. */
function PathChip({ path }: { path: string }) {
  return (
    <code className="rounded bg-muted px-1 py-0.5 text-[11px] text-foreground/90">
      {path}
    </code>
  )
}

/** Two-column key/value row used inside the data-location + about
 *  sections. Value is a selectable code chip so paths/versions copy
 *  cleanly. Wraps if the value is wider than the column. */
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 break-all rounded bg-muted px-1.5 py-0.5 text-foreground/90">
        {value}
      </code>
    </div>
  )
}

// MCP section - surfaces what an MCP-capable AI needs to connect to
// the running app's control channel (ADR-0018). Three blocks: status
// (running on 127.0.0.1:<port> + bearer token), the copy-paste config
// snippet (one shape covers Claude Desktop, Claude Code, etc. - the
// user asks their AI where exactly to paste it), and the underlying
// file paths (mcp.json / mcp-token + the MCP bundle the snippet was
// templated with). Full guide stays in docs/MCP.md.
function McpSection() {
  const { data: info, isLoading } = useQuery({
    queryKey: ['mcpInfo'],
    queryFn: () => ipc.mcpInfo(),
    staleTime: 30_000
  })

  if (isLoading || !info) {
    return (
      <Section title="MCP (AI integration)">
        <p className="px-1 text-xs text-muted-foreground">Loading…</p>
      </Section>
    )
  }

  return (
    <>
      <Section title="MCP control channel">
        <McpStatus
          running={info.channel.running}
          port={info.channel.port}
        />
        {info.channel.running && info.channel.token && (
          <TokenRow token={info.channel.token} />
        )}
        <p className="px-1 text-xs text-muted-foreground/80">
          Loopback only. The token blocks other local processes.
        </p>
      </Section>

      <Section title="Configure your AI">
        <SnippetBlock
          hint={
            <>
              Most MCP-capable AIs accept the snippet below. Ask yours
              where it goes.
            </>
          }
          text={info.snippets.mcpClientJson}
        />
      </Section>

      <Section title="Files">
        <DetailRow label="mcp.json" value={info.paths.mcpJson} />
        <DetailRow label="Token" value={info.paths.mcpToken} />
        <DetailRow
          label="Server bundle"
          value={
            info.paths.bundle ??
            'Not built yet. Run: pnpm --filter @kanbini/mcp run build'
          }
        />
      </Section>
    </>
  )
}

function McpStatus({
  running,
  port
}: {
  running: boolean
  port: number | null
}) {
  return (
    <div className="flex items-center gap-2 px-1 text-sm">
      <span
        className={cn(
          'inline-block size-2 rounded-full',
          running ? 'bg-emerald-500' : 'bg-red-500'
        )}
        aria-hidden
      />
      <span className="font-medium text-foreground">
        {running ? 'Running' : 'Not running'}
      </span>
      {running && port !== null && (
        <span className="text-muted-foreground">
          on <code className="rounded bg-muted px-1 py-0.5 text-xs">127.0.0.1:{port}</code>
        </span>
      )}
    </div>
  )
}

function TokenRow({ token }: { token: string }) {
  const [revealed, setRevealed] = useState(false)
  const masked = '•'.repeat(Math.min(64, token.length))
  return (
    <div className="flex flex-wrap items-center gap-2 px-1 text-xs">
      <span className="w-24 shrink-0 text-muted-foreground">Bearer token</span>
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-foreground/90">
        {revealed ? token : masked}
      </code>
      <button
        type="button"
        onClick={() => setRevealed((v) => !v)}
        aria-label={revealed ? 'Hide token' : 'Reveal token'}
        className="inline-flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </button>
      <CopyButton text={token} label="Copy token" />
    </div>
  )
}

/** Pre-formatted copy-paste block. Hint text rendered above; the body
 *  is monospace + scrollable so long paths don't blow up the panel. */
function SnippetBlock({
  hint,
  text
}: {
  hint: React.ReactNode
  text: string
}) {
  return (
    <>
      <p className="px-1 text-xs text-muted-foreground">{hint}</p>
      <div className="relative">
        <pre className="overflow-x-auto rounded border border-border bg-muted/50 p-2 pr-10 text-[11px] leading-snug text-foreground/90">
          {text}
        </pre>
        <span className="absolute right-1.5 top-1.5">
          <CopyButton text={text} label="Copy snippet" />
        </span>
      </div>
    </>
  )
}

/** Tiny clipboard button used by the token row + every snippet block.
 *  Shows a check for 1.5 s after a successful copy so the user gets
 *  visual confirmation without an opaque toast. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const onCopy = (): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={label}
      className="inline-flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {copied ? (
        <Check className="size-3.5 text-emerald-500" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </button>
  )
}

// About - version, runtime versions, and the data-location read-out
// (mirrored from the Data section so users who land here for the
// "where is my data?" question find it without a second click).
function AboutSection() {
  const { data: info, isLoading } = useQuery({
    queryKey: ['appInfo'],
    queryFn: () => ipc.appInfo(),
    staleTime: 60_000
  })

  return (
    <>
      <Section title="About">
        <div className="flex items-center gap-3 px-1">
          <img
            src={brandLogo}
            alt=""
            aria-hidden
            className="size-10 shrink-0"
            draggable={false}
          />
          <div className="flex flex-col">
            <span className="text-base font-semibold text-foreground">
              {APP_CODENAME}
            </span>
            <span className="text-xs text-muted-foreground">
              {info ? `Version ${info.version}` : 'Loading…'}
            </span>
          </div>
        </div>
        <p className="px-1 text-xs leading-snug text-muted-foreground">
          Offline desktop kanban. No accounts, no telemetry. Your
          data stays on your machine.
        </p>
      </Section>

      {info && (
        <>
          <Section title="Runtime">
            <DetailRow label="Electron" value={info.versions.electron} />
            <DetailRow label="Chromium" value={info.versions.chrome} />
            <DetailRow label="Node" value={info.versions.node} />
          </Section>

          <Section title="Data location">
            <DetailRow label="App data" value={info.paths.userData} />
            <DetailRow label="Database" value={info.paths.db} />
            <DetailRow label="Attachments" value={info.paths.attachments} />
            <DetailRow label="Backups" value={info.paths.export} />
          </Section>

          <Section title="Third-party software">
            <p className="px-1 text-xs leading-snug text-muted-foreground">
              Kanbini bundles open-source packages from {' '}
              <strong className="font-medium text-foreground">MIT</strong>,{' '}
              <strong className="font-medium text-foreground">Apache</strong>,{' '}
              <strong className="font-medium text-foreground">BSD</strong>, and{' '}
              <strong className="font-medium text-foreground">ISC</strong>{' '}
              license families. Full attribution and license text are
              in NOTICES.md.
            </p>
            <button
              type="button"
              disabled={!info.paths.notices}
              onClick={() => {
                void ipc.noticesOpen()
              }}
              className="self-start rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
            >
              Open NOTICES.md
            </button>
            {info.paths.notices && (
              <DetailRow label="Path" value={info.paths.notices} />
            )}
          </Section>
        </>
      )}

      {isLoading && (
        <p className="px-1 text-xs text-muted-foreground">Loading…</p>
      )}
    </>
  )
}

function ToggleRow({
  label,
  hint,
  checked,
  disabled,
  onChange
}: {
  label: string
  hint?: React.ReactNode
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <label
      className={cn(
        'flex items-start gap-3 rounded-md border border-border p-3 text-sm',
        disabled
          ? 'cursor-not-allowed opacity-60'
          : 'cursor-pointer hover:bg-accent'
      )}
    >
      <input
        type="checkbox"
        checked={checked && !disabled}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 cursor-pointer accent-primary disabled:cursor-not-allowed"
      />
      <span className="flex flex-col gap-0.5">
        <span className="font-medium text-foreground">{label}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  )
}

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <div className="flex flex-col gap-2 rounded-md border border-border bg-card/40 p-3">
        {children}
      </div>
    </section>
  )
}

function RadioRow<T extends string>({
  name,
  value,
  options,
  onChange
}: {
  name: string
  value: T
  options: Array<{ value: T; label: string; hint?: string }>
  onChange: (v: T) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      {options.map((o) => {
        const selected = o.value === value
        return (
          <label
            key={o.value}
            className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm transition-colors ${
              selected
                ? 'border-primary/60 bg-accent'
                : 'border-border hover:bg-accent'
            }`}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={selected}
              onChange={() => onChange(o.value)}
              className="mt-0.5 size-4 cursor-pointer accent-primary"
            />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium text-foreground">{o.label}</span>
              {o.hint && (
                <span className="text-xs text-muted-foreground">{o.hint}</span>
              )}
            </span>
          </label>
        )
      })}
    </div>
  )
}
