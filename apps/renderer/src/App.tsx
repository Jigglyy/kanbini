import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, Search, Settings } from 'lucide-react'
import { APP_CODENAME } from '@kanbini/shared'
// Brand mark rendered in the header - generated from images/Image #1
// by `pnpm --filter @kanbini/desktop run build:icons` (ADR-0051).
import brandLogo from './assets/logo.png'
import { boardsRootKey, useBoard } from './hooks/useBoard'
import { boardsListKey, useBoardsList } from './hooks/useBoardsList'
import { useBoardMutation } from './hooks/useBoardMutation'
import { ipc } from './lib/ipc'
import { Board } from './components/board'
import { BoardsHome } from './components/boards-home'
import { LabelBar } from './components/labels'
import { BoardSettings } from './components/board-settings'
import { AppSettings } from './components/app-settings'
import { CommandPalette } from './components/command-palette'
import { WelcomeModal } from './components/welcome-modal'
import { ZoomControl } from './components/zoom-control'
import { Tooltip } from './components/ui/tooltip'
import { useSettings } from './lib/settings'
import { recordOpened } from './lib/last-opened'
import { filterByLabels, pruneLabelFilter } from './lib/label-filter'
import { applyLabelOrder, moveLabelInOrder, reorderLabels } from './lib/label-order'
import { backgroundCss, tint } from './lib/palette'
import {
  resolveBindings,
  useShortcutDispatch,
  type ActionId
} from './lib/shortcuts'

// Live board: TanStack Query owns the data; the main-process
// change-event bus invalidates the `['board']` prefix and the
// boards-list key so local mutations, AI edits, and other windows
// all converge (ADR-0013).
//
// Routing (M4-G / ADR-0021): no router - a tiny in-component state
// machine flips between the home picker and a single board. The
// last-opened board id is persisted in localStorage; whether the
// app auto-jumps to it on launch is now a user preference (Settings
// → Startup; default = home picker).

type Route =
  | { kind: 'home' }
  | { kind: 'board'; id: string; openCardId?: string }
  | { kind: 'settings' }

// Show the platform-correct modifier in the search-button tooltip
// (Cmd on macOS, Ctrl elsewhere). Renderer-side check - Electron's
// renderer userAgent includes "Macintosh" on macOS.
const IS_MAC =
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent)
const SEARCH_SHORTCUT = IS_MAC ? '⌘F' : 'Ctrl+F'

const LAST_BOARD_KEY = 'kanbini.lastBoardId'

export function App() {
  const qc = useQueryClient()
  const { data: boards, status: boardsStatus } = useBoardsList()
  const [settings, updateSettings] = useSettings()
  const [route, setRoute] = useState<Route>({ kind: 'home' })
  // Where to return when Settings closes - captured the moment the
  // gear is pressed so the user lands back exactly where they were
  // (home or a specific board). Refs (not state) because nothing
  // visual depends on it; we just need a fresh value on close.
  const settingsReturnRef = useRef<Route>({ kind: 'home' })
  const [paletteOpen, setPaletteOpen] = useState(false)
  const didAutoJump = useRef(false)

  // On first successful boards load, optionally jump to the last-
  // opened board. Default startMode is 'home' - the picker shows so
  // multi-board users always see their full list first. Single-board
  // users can flip to 'lastBoard' in Settings → Startup for the
  // board-direct launch.
  useEffect(() => {
    if (didAutoJump.current || boardsStatus !== 'success') return
    didAutoJump.current = true
    if (settings.startMode !== 'lastBoard') return
    const last = localStorage.getItem(LAST_BOARD_KEY)
    if (last && boards?.some((b) => b.id === last)) {
      recordOpened(last)
      setRoute({ kind: 'board', id: last })
    }
  }, [boardsStatus, boards, settings.startMode])

  const openBoard = useCallback((id: string, openCardId?: string) => {
    localStorage.setItem(LAST_BOARD_KEY, id)
    recordOpened(id)
    setRoute({ kind: 'board', id, openCardId })
  }, [])
  const goHome = useCallback(() => setRoute({ kind: 'home' }), [])
  // Stable identity so <Board>'s memoised cards aren't re-rendered on
  // every parent render just because this handler changed (it only
  // actually changes when the flag flips, which is rare). Toggles the
  // Trello-style label bars ↔ names board-wide.
  const toggleLabelsExpanded = useCallback(
    () => updateSettings({ labelsExpanded: !settings.labelsExpanded }),
    [updateSettings, settings.labelsExpanded]
  )
  const openSettings = useCallback(() => {
    setRoute((prev) => {
      // Only capture the return target when entering Settings from
      // somewhere else. A second click while already on Settings is
      // a no-op for navigation, and must NOT overwrite the ref -
      // otherwise the Back button forgets the original board and
      // dumps the user on home.
      if (prev.kind !== 'settings') {
        settingsReturnRef.current = prev
      }
      return { kind: 'settings' }
    })
  }, [])
  const closeSettings = useCallback(() => {
    setRoute(settingsReturnRef.current)
  }, [])
  // Clear the route's one-shot openCardId once <Board> has consumed it.
  // Without this the route keeps the last-requested card id, so
  // re-activating the SAME card from the palette wouldn't change the
  // prop and the detail would never reopen (the local openCardId stays
  // whatever it was). Stable identity so it can sit in Board's effect
  // deps without re-firing.
  const clearRouteOpenCard = useCallback(() => {
    setRoute((prev) =>
      prev.kind === 'board' && prev.openCardId !== undefined
        ? { kind: 'board', id: prev.id }
        : prev
    )
  }, [])

  // ADR-0035: app-level shortcuts (search palette, back-to-home) go
  // through the same registry-driven dispatcher as the board-level
  // ones. Defaults cover Ctrl+F / Ctrl+K (and macOS Cmd+) so the
  // muscle memory still works out of the box; users can re-bind in
  // Settings → Shortcuts. Esc stays out of the registry (it's
  // modal-aware below).
  const navBindings = useMemo(
    () => resolveBindings(settings.shortcuts),
    [settings.shortcuts]
  )
  const navHandlers: Partial<Record<ActionId, (e: KeyboardEvent) => void>> = {
    'nav.search': (e) => {
      e.preventDefault()
      setPaletteOpen((prev) => !prev)
    },
    'nav.home': (e) => {
      if (route.kind === 'home') return
      // Overlay-aware, like Escape (below): don't yank the user home
      // from BEHIND an open modal / lightbox / context menu / popover.
      // Let them dismiss that surface first - matches the Escape
      // back-stack so the two affordances behave consistently.
      if (document.querySelector('[role="dialog"], [data-overlay]')) return
      e.preventDefault()
      if (route.kind === 'settings') closeSettings()
      else goHome()
    },
    // ADR-0036 undo / redo. The recorded inverse is applied
    // server-side; `changed` broadcast invalidates both the board
    // view and the boards-list, so the UI catches up the same way
    // as a normal mutation.
    //
    // Scoping (ADR-0036 revision): when the user is on a specific
    // board, the scope is that board's id - Ctrl+Z only touches
    // entries for the board they're looking at, never silently
    // edits a different board out of sight. When the user is on
    // home / settings, the scope is omitted (any entry is eligible)
    // and we auto-navigate to whichever board the undo affected so
    // they actually see the change.
    'edit.undo': (e) => {
      e.preventDefault()
      const scope = route.kind === 'board' ? route.id : undefined
      void ipc
        .undoApply({ scopeBoardId: scope })
        .then((result) => {
          if (
            result.applied &&
            result.boardId &&
            route.kind !== 'board'
          ) {
            openBoard(result.boardId)
          }
        })
        .catch(() => {})
    },
    'edit.redo': (e) => {
      e.preventDefault()
      const scope = route.kind === 'board' ? route.id : undefined
      void ipc
        .redoApply({ scopeBoardId: scope })
        .then((result) => {
          if (
            result.applied &&
            result.boardId &&
            route.kind !== 'board'
          ) {
            openBoard(result.boardId)
          }
        })
        .catch(() => {})
    }
  }
  useShortcutDispatch(navBindings, navHandlers)

  const currentBoardId = route.kind === 'board' ? route.id : undefined
  const apply = useBoardMutation(currentBoardId)
  const { data, status, error } = useBoard(currentBoardId)
  const [activeLabels, setActiveLabels] = useState<ReadonlySet<string>>(
    new Set()
  )

  // Reset label filter ONLY when the user lands on a different board
  // id, not every time currentBoardId flips through `undefined`. A
  // round-trip through Settings (board → undefined → same board)
  // would otherwise wipe a filter the user explicitly set. Same for
  // going to the home picker and reopening the same board - clearly
  // not "switching boards" in the user's sense of the word.
  const prevBoardIdRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!currentBoardId) return
    if (
      prevBoardIdRef.current &&
      prevBoardIdRef.current !== currentBoardId
    ) {
      setActiveLabels(new Set())
    }
    prevBoardIdRef.current = currentBoardId
  }, [currentBoardId])

  // Drop active filter ids whose label has been deleted (from the
  // filter-bar editor, or an AI / other-window edit) - otherwise the
  // stale id matches no card and strands the user on an empty board
  // with no chip left to clear. No-op (same set, no re-render) when
  // every active id still exists.
  useEffect(() => {
    if (!data) return
    setActiveLabels((prev) =>
      pruneLabelFilter(
        prev,
        data.labels.map((l) => l.id)
      )
    )
  }, [data])

  useEffect(() => {
    return ipc.onChange(() => {
      void qc.invalidateQueries({ queryKey: boardsRootKey })
      void qc.invalidateQueries({ queryKey: boardsListKey })
    })
  }, [qc])

  // Escape acts as "back" on board (→ picker) and settings (→ wherever
  // the user came from). Bails if any overlay is open (modal/lightbox
  // via role="dialog", context menu / popover via data-overlay) so the
  // first Escape closes that surface and a second Escape navigates -
  // matches what users expect from a stacked back-stack. Also bails
  // when focus is in an editable field (input/textarea/contenteditable)
  // so cancelling an inline rename doesn't yank the user out.
  useEffect(() => {
    if (route.kind === 'home') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const a = document.activeElement as HTMLElement | null
      if (a) {
        const tag = a.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
        if (a.isContentEditable) return
      }
      if (document.querySelector('[role="dialog"], [data-overlay]')) return
      if (route.kind === 'settings') closeSettings()
      else goHome()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [route.kind, goHome, closeSettings])

  // If the open board disappears (deleted from another window, or an
  // import wiped the DB), fall back to the picker. Also scrub the
  // settings-return ref so closing Settings doesn't bounce back into
  // a stale board id.
  useEffect(() => {
    if (boardsStatus !== 'success') return
    const ret = settingsReturnRef.current
    if (ret.kind === 'board' && !boards?.some((b) => b.id === ret.id)) {
      settingsReturnRef.current = { kind: 'home' }
    }
    if (route.kind !== 'board') return
    if (boards?.some((b) => b.id === route.id)) return
    setRoute({ kind: 'home' })
  }, [route, boards, boardsStatus])

  const toggleLabel = (id: string): void =>
    setActiveLabels((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const view = useMemo(
    () => (data ? filterByLabels(data, activeLabels) : null),
    [data, activeLabels]
  )

  // Header label-bar order: DB gives creation order; this layers the
  // user's manual per-board order (localStorage) on top. `labelOrderTick`
  // forces a re-apply after a move (localStorage isn't reactive).
  const [labelOrderTick, setLabelOrderTick] = useState(0)
  const orderedLabels = useMemo(
    () => (data ? applyLabelOrder(data.labels, data.board.id) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, labelOrderTick]
  )
  const moveLabel = (id: string, dir: -1 | 1): void => {
    if (!data) return
    moveLabelInOrder(
      data.board.id,
      orderedLabels.map((l) => l.id),
      id,
      dir
    )
    setLabelOrderTick((t) => t + 1)
  }
  const reorderLabel = (activeId: string, overId: string): void => {
    if (!data) return
    reorderLabels(
      data.board.id,
      orderedLabels.map((l) => l.id),
      activeId,
      overId
    )
    setLabelOrderTick((t) => t + 1)
  }

  // Tint the board-view header to echo the board's accent (M4-G+).
  // Subtle background mix toward the page bg, full-strength bottom
  // border. Falls back to neutral `border-border` when no colour set.
  const boardColor = route.kind === 'board' && data ? data.board.color : null
  const headerStyle: CSSProperties | undefined = boardColor
    ? {
        backgroundColor: tint(boardColor, 12, 'var(--color-background)'),
        borderBottomColor: boardColor
      }
    : undefined
  // ADR-0034 · paint the board view's background on <main>. Only when
  // a board is open; home + settings keep the neutral surface so they
  // don't double-up on the picker grid. Image kinds get `fixed`
  // attachment so the wallpaper holds steady as the user scrolls a
  // tall board.
  const boardBackground =
    route.kind === 'board' && data ? data.board.background : null
  const mainBgCss = backgroundCss(boardBackground)
  const mainStyle: CSSProperties | undefined =
    mainBgCss.image || mainBgCss.color
      ? {
          ...(mainBgCss.image ? { backgroundImage: mainBgCss.image } : {}),
          ...(mainBgCss.color ? { backgroundColor: mainBgCss.color } : {}),
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundAttachment: 'fixed'
        }
      : undefined

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header
        style={headerStyle}
        className={`flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-6 py-3 ${
          boardColor ? '' : 'border-border'
        }`}
      >
        <img
          src={brandLogo}
          alt=""
          aria-hidden
          className="size-6 shrink-0"
          draggable={false}
        />
        <h1 className="text-lg font-semibold tracking-tight">{APP_CODENAME}</h1>
        {route.kind === 'board' && (
          <>
            {/* Vertical divider between the app title and the
                breadcrumb. A thin slate bar reads as structure
                where a plain "/" reads as text. */}
            <span
              aria-hidden
              className="h-5 w-px bg-border"
            />
            <button
              type="button"
              onClick={goHome}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ChevronLeft className="size-4" />
              Boards
            </button>
            {status === 'success' && data && (
              <>
                <span
                  aria-hidden
                  className="text-muted-foreground/60"
                >
                  /
                </span>
                {/* Board accent dot + name + inline pencil-rename
                    sit together as a single visual chip. Name reads
                    in foreground (not muted) so the user knows where
                    they are at a glance. */}
                <div className="inline-flex items-center gap-1.5 rounded-md px-1 py-0.5">
                  {data.board.color && (
                    <span
                      aria-hidden
                      className="size-2 rounded-full"
                      style={{ backgroundColor: data.board.color }}
                    />
                  )}
                  <span className="text-sm font-medium text-foreground">
                    {data.board.name}
                  </span>
                  <BoardSettings board={data} apply={apply} />
                </div>
              </>
            )}
          </>
        )}

        {/* Right-aligned cluster: zoom chip (board only), search,
            and the app-wide settings cog (always). Single ml-auto so
            the cluster sits flush right regardless of how many items
            it contains. */}
        <div className="ml-auto flex items-center gap-2">
          {route.kind === 'board' && (
            <ZoomControl
              value={settings.boardZoom}
              onChange={(v) => updateSettings({ boardZoom: v })}
            />
          )}
          <Tooltip label={`Search (${SEARCH_SHORTCUT})`} side="bottom">
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-label="Search"
              className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Search className="size-4" />
            </button>
          </Tooltip>
          <Tooltip label="Settings" side="bottom">
            <button
              type="button"
              onClick={openSettings}
              aria-label="Settings"
              aria-pressed={route.kind === 'settings'}
              className={`inline-flex size-8 items-center justify-center rounded-md hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                route.kind === 'settings'
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground'
              }`}
            >
              <Settings className="size-4" />
            </button>
          </Tooltip>
        </div>

        {route.kind === 'board' && status === 'success' && data && (
          <div className="w-full">
            <LabelBar
              boardId={data.board.id}
              labels={orderedLabels}
              active={activeLabels}
              onToggle={toggleLabel}
              onMove={moveLabel}
              onReorder={reorderLabel}
              apply={apply}
            />
          </div>
        )}
      </header>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        boards={boards ?? []}
        onActivate={(boardId, cardId) => openBoard(boardId, cardId)}
      />

      {/* M5-B / ADR-0049 - first-run welcome. `hasSeenWelcome`
          flips false → true exactly once across the install's
          lifetime; the dismissal handler is also the persistence
          trigger so a quit-without-clicking still shows it next
          launch (good - they didn't actually see it). */}
      <WelcomeModal
        open={!settings.hasSeenWelcome}
        onDismiss={() => updateSettings({ hasSeenWelcome: true })}
      />

      {/* The single scroll container - `min-h-0` lets this flex child
          shrink below its content so `overflow-auto` engages instead
          of the document scrolling. Keeps the scrollbar inside the
          app (no reserved gutter strip on short boards) and means
          opening a modal never shifts the page. */}
      {/* `overflow-anchor:none`: useSmoothHeight manually compensates this
          container's scrollTop when a card ABOVE the fold changes height
          (the hover-expand reflow shifts the visible region; native
          anchoring doesn't catch the WAAPI tween). Disabling native
          anchoring here keeps that manual compensation the single source
          of truth so the two don't both adjust scrollTop and fight. */}
      <main
        style={mainStyle}
        className="min-h-0 flex-1 overflow-auto [overflow-anchor:none] p-6"
      >
        {route.kind === 'settings' ? (
          <AppSettings
            onClose={closeSettings}
            settings={settings}
            update={updateSettings}
          />
        ) : route.kind === 'home' ? (
          boardsStatus === 'pending' ? (
            <p className="text-sm text-muted-foreground">Loading boards…</p>
          ) : boardsStatus === 'error' ? (
            <p className="text-sm text-red-400">Couldn't load boards.</p>
          ) : (
            <BoardsHome boards={boards ?? []} onOpen={openBoard} />
          )
        ) : (
          <>
            {status === 'pending' && (
              <p className="text-sm text-muted-foreground">Loading board…</p>
            )}
            {status === 'error' && (
              <p className="text-sm text-red-400">Error: {String(error)}</p>
            )}
            {status === 'success' && !view && (
              <p className="text-sm text-muted-foreground">No board yet.</p>
            )}
            {status === 'success' && view && (
              // CSS `zoom` scales the board content only - header /
              // sidebar stay 1:1. Composes with Ctrl/Cmd +/- (which
              // zooms the whole window via Electron setZoomLevel).
              // Cast for older React typings that omit `zoom`.
              <div
                style={{ zoom: settings.boardZoom } as CSSProperties}
              >
                <Board
                  board={view}
                  blockCreate={settings.cardLimitBlocksCreate}
                  blockDrag={settings.cardLimitBlocksDrag}
                  showChecklist={settings.showChecklistOnCard}
                  labelsExpanded={settings.labelsExpanded}
                  onToggleLabelsExpanded={toggleLabelsExpanded}
                  linkPreviews={settings.linkPreviews}
                  autoCoverFromUrl={settings.autoCoverFromUrl}
                  boardZoom={settings.boardZoom}
                  initialOpenCardId={
                    route.kind === 'board' ? route.openCardId : undefined
                  }
                  onConsumedOpenCard={clearRouteOpenCard}
                />
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}

