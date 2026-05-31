import type {
  ActivityView,
  CardPriority,
  CardView,
  LabelView
} from '@kanbini/shared'
import { accentText } from '../lib/palette'
import { priorityLabel } from './priority'

// Card activity feed (M2-E). Reads from card.activities (server-supplied,
// last 30, newest first). Each row is one short line: a timestamp +
// terse description; the description's shape depends on the activity
// type. New activity arrives via the regular `changed` → invalidate
// path - no optimistic write here (a fresh activity row would race the
// upcoming refetch for no real UX gain).

export function Activity({
  card,
  labels
}: {
  card: CardView
  labels: LabelView[]
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-muted-foreground">Activity</h3>
      {card.activities.length === 0 ? (
        <p className="text-xs text-muted-foreground/70">No activity yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {card.activities.map((a) => (
            <ActivityRow key={a.id} activity={a} labels={labels} />
          ))}
        </ul>
      )}
    </section>
  )
}

function ActivityRow({
  activity,
  labels
}: {
  activity: ActivityView
  labels: LabelView[]
}) {
  return (
    <li className="flex items-baseline gap-2 text-xs text-muted-foreground">
      <span className="shrink-0 text-muted-foreground/60">
        {formatWhen(activity.createdAt)}
      </span>
      <span className="min-w-0 wrap-anywhere">
        {describe(activity, labels)}
      </span>
    </li>
  )
}

// ─── helpers ──────────────────────────────────────────────────────

const minute = 60_000
const hour = 60 * minute
const day = 24 * hour

/** Compact relative time: "just now", "12m", "3h", "2d", or a short
 *  date for older events. Keeps each row a single line. */
function formatWhen(ms: number): string {
  const diff = Date.now() - ms
  if (diff < minute) return 'just now'
  if (diff < hour) return `${Math.floor(diff / minute)}m`
  if (diff < day) return `${Math.floor(diff / hour)}h`
  if (diff < 7 * day) return `${Math.floor(diff / day)}d`
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  })
}

function formatDueDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

type LabelMeta = { id: string; name: string }

function isLabelArray(x: unknown): x is LabelMeta[] {
  return (
    Array.isArray(x) &&
    x.every(
      (v) =>
        v != null &&
        typeof v === 'object' &&
        typeof (v as { id?: unknown }).id === 'string'
    )
  )
}

function asRecord(x: unknown): Record<string, unknown> {
  // `typeof [] === 'object'` is true - guard against arrays too so a
  // future code path that logs an array as activity.data doesn't
  // produce a "record" with numeric keys. Same gotcha as the
  // loadOpenedMap fix in last-opened.ts.
  return x != null && typeof x === 'object' && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : {}
}

function LabelChip({
  meta,
  labels
}: {
  meta: LabelMeta
  labels: LabelView[]
}) {
  // Resolve the live colour if the label still exists; fall back to a
  // theme-aware neutral chip for removed labels (was a hardcoded dark
  // oklch that read as a dark chip on a light surface in light theme).
  const live = labels.find((l) => l.id === meta.id)
  if (!live) {
    return (
      <span className="rounded-sm bg-muted px-1 text-[10px] leading-4 text-muted-foreground">
        {meta.name}
      </span>
    )
  }
  return (
    <span
      className="rounded-sm px-1 text-[10px] leading-4"
      style={{ backgroundColor: live.color, color: accentText(live.color) }}
    >
      {meta.name}
    </span>
  )
}

function describe(
  activity: ActivityView,
  labels: LabelView[]
): React.ReactNode {
  const d = asRecord(activity.data)
  switch (activity.type) {
    case 'created':
      return 'created this card'
    case 'renamed':
      return (
        <>
          renamed to <strong className="text-foreground">{String(d.to)}</strong>
        </>
      )
    case 'completed':
      return 'marked complete'
    case 'reopened':
      return 'marked incomplete'
    case 'due-set':
      return (
        <>
          due {' '}
          <strong className="text-foreground">
            {formatDueDate(Number(d.dueAt))}
          </strong>
        </>
      )
    case 'due-cleared':
      return 'cleared the due date'
    case 'description':
      return 'updated the description'
    case 'cover-set':
      return 'set a cover image'
    case 'cover-cleared':
      return 'cleared the cover image'
    case 'priority-set': {
      const p = String(d.priority) as CardPriority
      return (
        <>
          set priority to{' '}
          <strong className="text-foreground">{priorityLabel(p)}</strong>
        </>
      )
    }
    case 'priority-cleared':
      return 'cleared the priority'
    case 'moved':
      return (
        <>
          moved to{' '}
          <strong className="text-foreground">
            {String(d.toListName ?? 'another list')}
          </strong>
        </>
      )
    // ADR-0041 on-enter rule fires. The 'moved' row immediately
    // before this one names the list; this row just says what the
    // rule did, so the feed reads as "moved to Done · auto-marked
    // complete on entry" across two adjacent rows.
    case 'rule-completed':
      return 'auto-marked complete on entry'
    case 'rule-uncompleted':
      return 'auto-marked incomplete on entry'
    case 'labels': {
      const added = isLabelArray(d.added) ? d.added : []
      const removed = isLabelArray(d.removed) ? d.removed : []
      if (added.length === 0 && removed.length === 0) return 'updated labels'
      return (
        <span className="inline-flex flex-wrap items-baseline gap-1">
          {added.length > 0 && (
            <>
              <span>added</span>
              {added.map((m) => (
                <LabelChip key={`a-${m.id}`} meta={m} labels={labels} />
              ))}
            </>
          )}
          {added.length > 0 && removed.length > 0 && <span>·</span>}
          {removed.length > 0 && (
            <>
              <span>removed</span>
              {removed.map((m) => (
                <LabelChip key={`r-${m.id}`} meta={m} labels={labels} />
              ))}
            </>
          )}
        </span>
      )
    }
    case 'ai-comment':
      return 'AI posted a comment'
    case 'checklist-added':
      return (
        <>
          added checklist{' '}
          <strong className="text-foreground">{String(d.name)}</strong>
        </>
      )
    case 'checklist-removed':
      return (
        <>
          removed checklist{' '}
          <strong className="text-foreground">{String(d.name)}</strong>
        </>
      )
    case 'attachment-added':
      return (
        <>
          attached{' '}
          <strong className="text-foreground">{String(d.filename)}</strong>
        </>
      )
    case 'attachment-removed':
      return (
        <>
          removed{' '}
          <strong className="text-foreground">{String(d.filename)}</strong>
        </>
      )
    default:
      return activity.type
  }
}
