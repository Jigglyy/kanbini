import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { History } from 'lucide-react'
import type { BackupInfo, ImportSummary } from '@kanbini/shared'
import { ipc } from '../lib/ipc'

// Settings > Backup & restore > Daily backups. Kanbini keeps a copy of
// everything once a day (the last 7 days) and one right before every
// restore (@kanbini/db backups.ts, main's dailyBackup). Restoring one
// replaces everything, after main keeps a copy of how things are now.

export const backupsKey = ['backups'] as const

const DAY_MS = 24 * 60 * 60 * 1000

/** "Today, 18:04" / "Yesterday, 09:12" / "Mon 27 Oct, 18:04", in the
 *  user's locale. Pure, for tests. */
export function backupWhen(takenAt: number, now: number = Date.now()): string {
  const d = new Date(takenAt)
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const dayStart = (t: number) => {
    const x = new Date(t)
    x.setHours(0, 0, 0, 0)
    return x.getTime()
  }
  const days = Math.round((dayStart(now) - dayStart(takenAt)) / DAY_MS)
  const day =
    days === 0
      ? 'Today'
      : days === 1
        ? 'Yesterday'
        : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  return `${day}, ${time}`
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

export function BackupList({ folder }: { folder?: string }) {
  const qc = useQueryClient()
  const { data: backups } = useQuery({ queryKey: backupsKey, queryFn: () => ipc.backupsList() })
  const [confirming, setConfirming] = useState<string | null>(null)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [done, setDone] = useState<{ backup: BackupInfo; summary: ImportSummary } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const restore = async (b: BackupInfo): Promise<void> => {
    setRestoring(b.name)
    setError(null)
    try {
      const summary = await ipc.backupsRestore({ name: b.name })
      setDone({ backup: b, summary })
      setConfirming(null)
      // The restore added a "before restore" copy to the list.
      await qc.invalidateQueries({ queryKey: backupsKey })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRestoring(null)
    }
  }

  return (
    <>
      <p className="px-1 text-xs text-muted-foreground">
        Kanbini keeps a copy of everything once a day, for the last 7 days,
        and another one right before you restore anything.
        {folder && (
          <>
            {' '}
            They're in{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-[11px] text-foreground/90">
              {folder}
            </code>
            .
          </>
        )}
      </p>
      {backups && backups.length === 0 && (
        <p className="px-1 text-xs text-muted-foreground">
          No backups yet. The first one is made when you next close Kanbini.
        </p>
      )}
      {backups && backups.length > 0 && (
        <ul className="flex flex-col divide-y divide-border rounded border border-border bg-background">
          {backups.map((b) => (
            <li
              key={b.name}
              aria-label={backupWhen(b.takenAt)}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 text-sm"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-foreground">
                  {backupWhen(b.takenAt)}
                  {b.kind === 'before-restore' && (
                    <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                      Before a restore
                    </span>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">
                  {plural(b.boards, 'board')} · {plural(b.cards, 'card')}
                </span>
              </span>
              {confirming === b.name ? (
                <span className="flex items-center gap-2">
                  <span className="text-xs text-warning">Replace everything with this?</span>
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    disabled={restoring !== null}
                    className="rounded border border-border bg-background px-2.5 py-1 text-xs text-foreground hover:border-ring"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void restore(b)}
                    disabled={restoring !== null}
                    className="rounded border border-border bg-background px-2.5 py-1 text-xs text-foreground hover:border-ring disabled:cursor-wait disabled:opacity-60"
                  >
                    {restoring === b.name ? 'Restoring…' : 'Restore'}
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setConfirming(b.name)
                    setDone(null)
                  }}
                  className="flex items-center gap-1.5 rounded border border-border bg-background px-2.5 py-1 text-xs text-foreground hover:border-ring"
                >
                  <History className="size-3.5" />
                  Restore…
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {done && (
        <span className="text-xs text-muted-foreground">
          Restored {backupWhen(done.backup.takenAt)}: {plural(done.summary.counts.boards, 'board')},{' '}
          {plural(done.summary.counts.cards, 'card')}. What you had before is the newest
          &ldquo;Before a restore&rdquo; copy.
        </span>
      )}
      {error && <span className="text-xs text-danger">{error}</span>}
    </>
  )
}
