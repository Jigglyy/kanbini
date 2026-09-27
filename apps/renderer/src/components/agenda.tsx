import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, Flag, Lock } from 'lucide-react'
import type { AgendaItem, AgendaView } from '@kanbini/shared'
import { agendaKey, useAgenda } from '../hooks/useAgenda'
import {
  AGENDA_PREVIEW_COUNT,
  agendaWhen,
  type AgendaSection
} from '../lib/agenda'
import { ipc } from '../lib/ipc'
import { cn } from '../lib/utils'
import { priorityColor, priorityLabel } from './priority'

// Boards-home Agenda: what's overdue, due today, coming up, and recently
// finished, across every board. Reads `getAgenda` over IPC (the same
// read the MCP `kanbini_get_agenda` tool uses), refreshed live by the
// app-wide change listener. A row click opens the card on its board;
// the checkbox completes / reopens it in place.
//
// The panel collapses to a one-line summary; that choice persists per
// machine in localStorage, like the home sort mode.

const COLLAPSED_KEY = 'kanbini.agendaCollapsed'

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function saveCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0')
  } catch {
    /* private mode - the toggle still works for this session */
  }
}

interface Props {
  onOpenCard: (boardId: string, cardId: string) => void
}

export function AgendaPanel({ onOpenCard }: Props) {
  const { data } = useAgenda()
  const [collapsed, setCollapsed] = useState(loadCollapsed)

  if (!data) return null

  const toggle = (): void => {
    setCollapsed((c) => {
      saveCollapsed(!c)
      return !c
    })
  }

  const { totals } = data
  const empty =
    totals.overdue + totals.today + totals.upcoming + totals.completed === 0

  return (
    <section
      aria-label="Agenda"
      className="rounded-lg border border-border bg-muted/40"
    >
      {/* Disclosure pattern: the button lives INSIDE the heading (a
          heading can't sit inside a button). */}
      <h2>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronDown
            aria-hidden
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform',
              collapsed && '-rotate-90'
            )}
          />
          <span className="text-base font-semibold tracking-tight">Agenda</span>
          <AgendaSummary view={data} />
        </button>
      </h2>

      {!collapsed &&
        (empty ? (
          <p className="px-3 pb-3 text-sm text-muted-foreground">
            Nothing due in the next {data.upcomingDays} days. Give a card a
            due date and it shows up here.
          </p>
        ) : (
          <div className="grid gap-x-4 gap-y-3 px-3 pb-3 sm:grid-cols-2 lg:grid-cols-4">
            <AgendaGroup
              section="overdue"
              title="Overdue"
              items={data.overdue}
              total={totals.overdue}
              view={data}
              emptyText="Nothing overdue"
              onOpenCard={onOpenCard}
            />
            <AgendaGroup
              section="today"
              title="Due today"
              items={data.today}
              total={totals.today}
              view={data}
              emptyText="Nothing due today"
              onOpenCard={onOpenCard}
            />
            <AgendaGroup
              section="upcoming"
              title={`Next ${data.upcomingDays} days`}
              items={data.upcoming}
              total={totals.upcoming}
              view={data}
              emptyText="Nothing coming up"
              onOpenCard={onOpenCard}
            />
            <AgendaGroup
              section="completed"
              title="Recently completed"
              items={data.completed}
              total={totals.completed}
              view={data}
              emptyText="Nothing completed lately"
              onOpenCard={onOpenCard}
            />
          </div>
        ))}
    </section>
  )
}

/** Inline counts beside the heading - the whole story when collapsed. */
function AgendaSummary({ view }: { view: AgendaView }) {
  const { totals } = view
  const parts: Array<{ key: string; text: string; danger?: boolean }> = []
  if (totals.overdue > 0) {
    parts.push({ key: 'o', text: `${totals.overdue} overdue`, danger: true })
  }
  if (totals.today > 0) parts.push({ key: 't', text: `${totals.today} today` })
  if (totals.upcoming > 0) {
    parts.push({ key: 'u', text: `${totals.upcoming} coming up` })
  }
  if (totals.completed > 0) {
    parts.push({ key: 'c', text: `${totals.completed} done` })
  }
  if (parts.length === 0) return null
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
      {parts.map((p, i) => (
        <span key={p.key} className={cn(p.danger && 'font-medium text-danger')}>
          {i > 0 && <span aria-hidden className="mr-2 text-muted-foreground">·</span>}
          {p.text}
        </span>
      ))}
    </span>
  )
}

function AgendaGroup({
  section,
  title,
  items,
  total,
  view,
  emptyText,
  onOpenCard
}: {
  section: AgendaSection
  title: string
  items: AgendaItem[]
  total: number
  view: AgendaView
  emptyText: string
  onOpenCard: Props['onOpenCard']
}) {
  const [showAll, setShowAll] = useState(false)
  const shown = showAll ? items : items.slice(0, AGENDA_PREVIEW_COUNT)
  const hiddenHere = items.length - shown.length
  const notLoaded = total - items.length
  const headingId = `agenda-${section}`

  return (
    <div className="min-w-0">
      <h3
        id={headingId}
        className={cn(
          'mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide',
          section === 'overdue' && total > 0
            ? 'text-danger'
            : 'text-muted-foreground'
        )}
      >
        {title}
        <span className="font-normal">({total})</span>
      </h3>
      {items.length === 0 ? (
        <p className="px-1.5 py-1 text-sm text-muted-foreground/80">{emptyText}</p>
      ) : (
        <ul aria-labelledby={headingId} className="flex flex-col">
          {shown.map((item) => (
            <AgendaRow
              key={item.cardId}
              item={item}
              section={section}
              dayStart={view.dayStart}
              onOpenCard={onOpenCard}
            />
          ))}
        </ul>
      )}
      {(hiddenHere > 0 || showAll) && items.length > AGENDA_PREVIEW_COUNT && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-0.5 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {showAll ? 'Show less' : `Show ${hiddenHere} more`}
        </button>
      )}
      {showAll && notLoaded > 0 && (
        <p className="px-1.5 text-xs text-muted-foreground">
          …and {notLoaded} more. Use search to find the rest.
        </p>
      )}
    </div>
  )
}

function AgendaRow({
  item,
  section,
  dayStart,
  onOpenCard
}: {
  item: AgendaItem
  section: AgendaSection
  dayStart: number
  onOpenCard: Props['onOpenCard']
}) {
  const qc = useQueryClient()
  const [pending, setPending] = useState(false)
  const done = section === 'completed'
  const when = agendaWhen(section, item, dayStart)

  async function toggleComplete(): Promise<void> {
    if (pending) return
    setPending(true)
    try {
      await ipc.mutate({
        type: 'card.update',
        id: item.cardId,
        patch: { completed: !done }
      })
      await qc.invalidateQueries({ queryKey: agendaKey })
    } catch (e) {
      console.warn('agenda: could not update card', e)
    } finally {
      setPending(false)
    }
  }

  return (
    <li className="flex items-start gap-2 rounded-md px-1.5 py-1 hover:bg-accent/60">
      <button
        type="button"
        role="checkbox"
        aria-checked={done}
        aria-label={done ? `Mark "${item.title}" incomplete` : `Mark "${item.title}" complete`}
        disabled={pending}
        onClick={() => void toggleComplete()}
        className={cn(
          'mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
          done
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-muted-foreground/60 hover:border-foreground'
        )}
      >
        {done && <Check aria-hidden className="size-3" strokeWidth={3} />}
      </button>
      <button
        type="button"
        onClick={() => onOpenCard(item.boardId, item.cardId)}
        title={`Open "${item.title}" on ${item.boardName}`}
        className="min-w-0 flex-1 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span
          className={cn(
            'line-clamp-2 text-sm leading-5 wrap-anywhere',
            done && 'text-muted-foreground line-through'
          )}
        >
          {item.title}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-full border border-border"
            style={item.boardColor ? { backgroundColor: item.boardColor, borderColor: item.boardColor } : undefined}
          />
          <span className="truncate">
            {item.boardName} · {item.listName}
          </span>
        </span>
      </button>
      {(item.priority || when || item.blocked) && (
        <span className="mt-0.5 flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          {item.blocked && !done && (
            <span
              role="img"
              aria-label="Blocked: waiting on another card"
              title="Blocked: waiting on another card"
              className="flex text-warning"
            >
              <Lock className="size-3" aria-hidden />
            </span>
          )}
          {item.priority && !done && (
            <Flag
              aria-label={`Priority: ${priorityLabel(item.priority)}`}
              className="size-3"
              style={{ color: priorityColor(item.priority) }}
              fill={priorityColor(item.priority)}
            />
          )}
          {when && (
            <span className={cn(section === 'overdue' && 'text-danger')}>{when}</span>
          )}
        </span>
      )}
    </li>
  )
}
