import { useState } from 'react'
import { Check, Image as ImageIcon, Palette, Sparkles, Trash2, X } from 'lucide-react'
import type { BoardBackground, Mutation } from '@kanbini/shared'
import { ipc } from '../lib/ipc'
import { ACCENTS, GRADIENT_PRESETS, backgroundCss } from '../lib/palette'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { Modal } from './ui/modal'

// ADR-0034 · Board background picker. Three tabs (Color / Gradient /
// Image) inside one modal. Caller wires `apply` to a board.update
// mutation so the picker is decoupled from the optimistic-cache
// plumbing (works the same from the boards-home context menu and the
// board-view rename popover). Image uploads go through the
// `board:setBackgroundImage` IPC - main owns the file copy + clean-up
// of the previous image.

type Tab = 'color' | 'gradient' | 'image'

interface Props {
  open: boolean
  boardId: string
  value: BoardBackground | null
  /** Apply a board.update - caller provides the appropriate optimistic
   *  cache write OR plain mutateAndInvalidate. */
  apply: (m: Extract<Mutation, { type: 'board.update' }>) => void
  onClose: () => void
}

export function BackgroundPicker({
  open,
  boardId,
  value,
  apply,
  onClose
}: Props) {
  // Pick the tab that matches the current value so the user starts on
  // whatever's already set (or Color when nothing is set).
  const initialTab: Tab =
    value?.kind === 'gradient'
      ? 'gradient'
      : value?.kind === 'image'
        ? 'image'
        : 'color'
  const [tab, setTab] = useState<Tab>(initialTab)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const setBg = (next: BoardBackground | null): void => {
    apply({ type: 'board.update', id: boardId, patch: { background: next } })
  }

  const onPickImage = async (): Promise<void> => {
    setUploading(true)
    setUploadError(null)
    try {
      const next = await ipc.boardSetBackgroundImage({ boardId })
      if (next) onClose()
      // null = picker cancelled - leave the modal open so the user
      // can pick again or switch tabs.
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Could not set image.')
    } finally {
      setUploading(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} label="Board background">
      <div className="flex flex-col gap-4 p-5">
        <header className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Board background</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </header>

        {/* Preview of the current value (or "None") so the user sees what
            they have BEFORE picking something new. */}
        <CurrentPreview value={value} onClear={() => setBg(null)} />

        <div role="tablist" aria-label="Background type" className="flex gap-1 rounded-md bg-muted/40 p-1">
          <TabButton current={tab} value="color" setTab={setTab} icon={<Palette className="size-3.5" />}>
            Color
          </TabButton>
          <TabButton current={tab} value="gradient" setTab={setTab} icon={<Sparkles className="size-3.5" />}>
            Gradient
          </TabButton>
          <TabButton current={tab} value="image" setTab={setTab} icon={<ImageIcon className="size-3.5" />}>
            Image
          </TabButton>
        </div>

        {tab === 'color' && (
          <ColorTab
            current={value?.kind === 'color' ? value.value : null}
            onPick={(v) => {
              setBg({ kind: 'color', value: v })
              onClose()
            }}
          />
        )}

        {tab === 'gradient' && (
          <GradientTab
            current={value?.kind === 'gradient' ? value.preset : null}
            onPick={(preset) => {
              setBg({ kind: 'gradient', preset })
              onClose()
            }}
          />
        )}

        {tab === 'image' && (
          <ImageTab
            current={value?.kind === 'image' ? value.relPath : null}
            uploading={uploading}
            error={uploadError}
            onPick={() => void onPickImage()}
          />
        )}
      </div>
    </Modal>
  )
}

function TabButton({
  current,
  value,
  setTab,
  children,
  icon
}: {
  current: Tab
  value: Tab
  setTab: (t: Tab) => void
  children: React.ReactNode
  icon: React.ReactNode
}) {
  const active = current === value
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => setTab(value)}
      className={cn(
        'flex-1 inline-flex items-center justify-center gap-1.5 rounded px-2 py-1.5 text-sm transition-colors',
        active
          ? 'bg-card text-foreground shadow'
          : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {icon}
      {children}
    </button>
  )
}

function CurrentPreview({
  value,
  onClear
}: {
  value: BoardBackground | null
  onClear: () => void
}) {
  const css = backgroundCss(value)
  const empty = !css.image && !css.color
  return (
    <div className="flex items-center gap-3">
      <div
        aria-label="Current background"
        className={cn(
          'h-14 w-24 shrink-0 rounded border border-border bg-cover bg-center',
          empty && 'bg-muted'
        )}
        style={{
          ...(css.image ? { backgroundImage: css.image } : {}),
          ...(css.color ? { backgroundColor: css.color } : {})
        }}
      />
      <div className="flex flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium">Current</span>
        <span className="text-xs text-muted-foreground">
          {value ? labelFor(value) : 'No background. Uses the board accent.'}
        </span>
      </div>
      {value && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onClear}
          className="text-muted-foreground hover:text-foreground"
        >
          <Trash2 className="size-3.5" />
          Clear
        </Button>
      )}
    </div>
  )
}

function labelFor(bg: BoardBackground): string {
  if (bg.kind === 'color') return `Color · ${bg.value}`
  if (bg.kind === 'gradient') {
    const found = GRADIENT_PRESETS.find((g) => g.key === bg.preset)
    return found ? `Gradient · ${found.label}` : `Gradient · ${bg.preset}`
  }
  return `Image · ${bg.relPath.split('/').pop() ?? bg.relPath}`
}

function ColorTab({
  current,
  onPick
}: {
  current: string | null
  onPick: (value: string) => void
}) {
  // Drives the native colour picker. Keep a local buffer so the user
  // can scrub the picker without firing a mutation on every step;
  // commit on `change` (input → live, change → committed).
  const [custom, setCustom] = useState(current ?? '#3b82f6')
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Presets
        </span>
        <div className="flex flex-wrap gap-2">
          {ACCENTS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onPick(c)}
              aria-label={`Pick ${c}`}
              className={cn(
                'inline-flex size-10 items-center justify-center rounded-md border border-border',
                current === c && 'ring-2 ring-ring'
              )}
              style={{ backgroundColor: c }}
            >
              {current === c && <Check className="size-4 text-white drop-shadow" />}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Custom
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={cssHexFor(custom)}
              onChange={(e) => setCustom(e.target.value)}
              className="size-10 cursor-pointer rounded border border-border bg-transparent p-0.5"
            />
            <input
              type="text"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="#3b82f6 or oklch(0.62 0.15 250)"
              className="flex-1 rounded border border-border bg-background px-2 py-1 text-sm focus:border-ring focus:outline-none"
            />
            <Button size="sm" onClick={() => onPick(custom.trim())} disabled={!custom.trim()}>
              Apply
            </Button>
          </div>
        </label>
      </div>
    </div>
  )
}

/** The native <input type="color"> only accepts #rrggbb. If the
 *  current value isn't a hex, fall back to a neutral so the swatch
 *  doesn't render as transparent and confuse the user. */
function cssHexFor(value: string): string {
  return /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim() : '#3b82f6'
}

function GradientTab({
  current,
  onPick
}: {
  current: string | null
  onPick: (preset: string) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {GRADIENT_PRESETS.map((g) => {
        const active = g.key === current
        return (
          <button
            key={g.key}
            type="button"
            onClick={() => onPick(g.key)}
            aria-label={`Pick ${g.label} gradient`}
            className={cn(
              'group relative flex h-20 flex-col justify-end overflow-hidden rounded-md border border-border p-2 text-left',
              active && 'ring-2 ring-ring'
            )}
            style={{ background: g.css }}
          >
            <span className="text-xs font-medium text-white drop-shadow">
              {g.label}
            </span>
            {active && (
              <Check className="absolute right-2 top-2 size-4 text-white drop-shadow" />
            )}
          </button>
        )
      })}
    </div>
  )
}

function ImageTab({
  current,
  uploading,
  error,
  onPick
}: {
  current: string | null
  uploading: boolean
  error: string | null
  onPick: () => void
}) {
  return (
    <div className="flex flex-col gap-3">
      {current && (
        <div
          aria-label="Current background image"
          className="h-32 w-full rounded-md border border-border bg-cover bg-center"
          style={{
            backgroundImage: backgroundCss({ kind: 'image', relPath: current }).image ?? undefined
          }}
        />
      )}
      <Button onClick={onPick} disabled={uploading} className="self-start">
        <ImageIcon className="size-3.5" />
        {uploading ? 'Uploading…' : current ? 'Replace image…' : 'Choose image…'}
      </Button>
      {error && (
        <p className="rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">
          {error}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        PNG, JPG, GIF, WebP, AVIF or SVG. Copied into your local
        Kanbini folder. Nothing leaves your machine.
      </p>
    </div>
  )
}
