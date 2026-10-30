import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { BackupInfo } from '@kanbini/shared'
import type { Db } from './client'
import { exportToFolder } from './export'

// Dated backups under `<userData>/backups/`: one a day, the last
// DAILY_BACKUPS_KEPT days kept, plus a safety copy right before every
// restore (the last SAFETY_BACKUPS_KEPT kept). Each one is a complete
// export folder (kanbini.json + cards/ + attachments/ + board-backgrounds/),
// so restoring one is the ordinary importFromFolder, and a user can also
// pick one with "Restore from folder...".
//
// Disk: a daily backup is the fresh quit-time export, HARDLINKED file by
// file. The export never rewrites a file in place (it stages a new folder
// and swaps it in) and already hardlinks unchanged attachments from the
// previous export, so the export and every backup share one copy of each
// attachment. Only kanbini.json and the description files differ per day.

export const BACKUPS_DIR = 'backups'
export const DAILY_BACKUPS_KEPT = 7
export const SAFETY_BACKUPS_KEPT = 3

const DAILY = /^(\d{4})-(\d{2})-(\d{2})$/
const SAFETY = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})-before-restore$/

const pad = (n: number): string => String(n).padStart(2, '0')

/** Today's daily backup folder name, by the LOCAL calendar day. */
export function dailyBackupName(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function safetyBackupName(now: Date): string {
  return (
    `${dailyBackupName(now)}_${pad(now.getHours())}-${pad(now.getMinutes())}-` +
    `${pad(now.getSeconds())}-before-restore`
  )
}

export function backupKind(name: string): BackupInfo['kind'] | null {
  if (DAILY.test(name)) return 'daily'
  if (SAFETY.test(name)) return 'before-restore'
  return null
}

/** The folder of backup `name`, or null for anything that isn't a backup
 *  name (the name comes from the renderer, so no paths sneak through). */
export function backupPath(backupsRoot: string, name: string): string | null {
  return backupKind(name) ? join(backupsRoot, name) : null
}

async function exists(path: string): Promise<boolean> {
  try {
    await fsp.access(path)
    return true
  } catch {
    return false
  }
}

/** Copy the folder tree `src` to `dest` by hardlinking each file (a plain
 *  copy where linking fails, e.g. another drive). Staged next to `dest`
 *  and renamed into place, so a half-written backup never looks real. */
async function snapshotFolder(src: string, dest: string): Promise<void> {
  const stage = `${dest}.staging`
  await fsp.rm(stage, { recursive: true, force: true })
  const walk = async (from: string, to: string): Promise<void> => {
    await fsp.mkdir(to, { recursive: true })
    for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
      const a = join(from, entry.name)
      const b = join(to, entry.name)
      if (entry.isDirectory()) await walk(a, b)
      else if (entry.isFile()) {
        try {
          await fsp.link(a, b)
        } catch {
          await fsp.copyFile(a, b)
        }
      }
    }
  }
  try {
    await walk(src, stage)
    await fsp.rename(stage, dest)
  } catch (err) {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

/** Remove all but the newest `keep` backups of `kind`. Names sort by time. */
async function prune(backupsRoot: string, kind: BackupInfo['kind'], keep: number): Promise<void> {
  let names: string[]
  try {
    names = await fsp.readdir(backupsRoot)
  } catch {
    return
  }
  const mine = names.filter((n) => backupKind(n) === kind).sort()
  for (const name of mine.slice(0, Math.max(0, mine.length - keep))) {
    await fsp.rm(join(backupsRoot, name), { recursive: true, force: true }).catch(() => {})
  }
}

/** True when today's daily backup is already there. */
export function hasDailyBackup(backupsRoot: string, now: Date = new Date()): Promise<boolean> {
  return exists(join(backupsRoot, dailyBackupName(now)))
}

/** Keep the export at `exportRoot` (just written) as today's backup,
 *  unless today has one already; then trim to the newest
 *  DAILY_BACKUPS_KEPT. Returns the new backup's name, or null. */
export async function takeDailyBackup(opts: {
  exportRoot: string
  backupsRoot: string
  now?: Date
}): Promise<string | null> {
  const now = opts.now ?? new Date()
  const name = dailyBackupName(now)
  if (await exists(join(opts.backupsRoot, name))) return null
  await fsp.mkdir(opts.backupsRoot, { recursive: true })
  await snapshotFolder(opts.exportRoot, join(opts.backupsRoot, name))
  await prune(opts.backupsRoot, 'daily', DAILY_BACKUPS_KEPT)
  return name
}

/** Export the database as it is right now into a "before restore"
 *  backup, then trim to the newest SAFETY_BACKUPS_KEPT. Written straight
 *  from the DB (not via the main export folder, which might be the very
 *  folder about to be restored); unchanged attachments are hardlinked
 *  from `exportRoot`. Returns the backup's name. */
export async function takeSafetyBackup(opts: {
  db: Db
  userDataDir: string
  exportRoot: string
  backupsRoot: string
  now?: Date
}): Promise<string> {
  const name = safetyBackupName(opts.now ?? new Date())
  await fsp.mkdir(opts.backupsRoot, { recursive: true })
  await exportToFolder(opts.db, opts.userDataDir, join(opts.backupsRoot, name), {
    reuseFrom: opts.exportRoot
  })
  await prune(opts.backupsRoot, 'before-restore', SAFETY_BACKUPS_KEPT)
  return name
}

/** Every backup, newest first, with what's in it. A folder whose
 *  kanbini.json can't be read is left out. */
export async function listBackups(backupsRoot: string): Promise<BackupInfo[]> {
  let names: string[]
  try {
    names = await fsp.readdir(backupsRoot)
  } catch {
    return []
  }
  const out: BackupInfo[] = []
  for (const name of names) {
    const kind = backupKind(name)
    if (!kind) continue
    try {
      const dump = JSON.parse(
        await fsp.readFile(join(backupsRoot, name, 'kanbini.json'), 'utf8')
      ) as { exportedAt?: unknown; boards?: unknown[]; cards?: unknown[] }
      out.push({
        name,
        kind,
        takenAt: typeof dump.exportedAt === 'number' ? dump.exportedAt : 0,
        boards: dump.boards?.length ?? 0,
        cards: dump.cards?.length ?? 0
      })
    } catch {
      /* not a readable export - skip it */
    }
  }
  return out.sort((a, b) => b.takenAt - a.takenAt || (a.name < b.name ? 1 : -1))
}
