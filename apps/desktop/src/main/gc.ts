import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { type Db, listAttachmentIds, listBoards } from '@kanbini/db'

// Orphaned-file GC (the "M5 GC sweep" the backlog kept pointing at).
// Files accumulate without a reaper from three sources:
//   - MCP-issued attachment.delete removes the row but never unlinks
//     (only the renderer IPC path does the file work)
//   - undo-log pruning drops restore entries whose rows are gone but
//     whose files were left for a redo that can never come
//   - replaced link-preview covers + board backgrounds in edge paths
//
// Policy: delete only what provably belongs to NOTHING - an
// attachments/<id>/ dir whose id has no attachment row, or a
// board-backgrounds/<boardId>/ entry that isn't the board's current
// background file. An age floor keeps the sweep clear of in-flight
// writes (attachmentAdd mkdirs BEFORE the row insert) and of
// fresh-but-still-undoable deletes from this session.

/** Only sweep entries untouched for at least this long. */
const MIN_AGE_MS = 60 * 60 * 1000 // 1 hour

export interface GcSummary {
  removedAttachmentDirs: number
  removedBackgroundEntries: number
}

async function olderThanFloor(path: string): Promise<boolean> {
  try {
    const st = await fsp.stat(path)
    return Date.now() - st.mtimeMs > MIN_AGE_MS
  } catch {
    return false
  }
}

export async function sweepOrphanedFiles(opts: {
  db: Db
  attachmentsRoot: string
  backgroundsRoot: string
}): Promise<GcSummary> {
  const { db, attachmentsRoot, backgroundsRoot } = opts
  const summary: GcSummary = {
    removedAttachmentDirs: 0,
    removedBackgroundEntries: 0
  }

  // attachments/<id>/ dirs with no matching row.
  const liveAttachmentIds = new Set(listAttachmentIds(db))
  let attachmentEntries: string[] = []
  try {
    attachmentEntries = await fsp.readdir(attachmentsRoot)
  } catch {
    /* root not created yet - nothing to sweep */
  }
  for (const entry of attachmentEntries) {
    if (liveAttachmentIds.has(entry)) continue
    const dir = join(attachmentsRoot, entry)
    if (!(await olderThanFloor(dir))) continue
    try {
      await fsp.rm(dir, { recursive: true, force: true })
      summary.removedAttachmentDirs++
    } catch {
      /* locked / permission - try again next launch */
    }
  }

  // board-backgrounds/<boardId>/: a dir for a deleted board goes
  // entirely; for a live board only its CURRENT background file stays
  // (boardSetBackgroundImage already best-effort-deletes the previous
  // file, but a crash between apply + cleanup leaks one).
  const boards = listBoards(db)
  const keepByBoard = new Map<string, string | null>()
  for (const b of boards) {
    keepByBoard.set(
      b.id,
      b.background?.kind === 'image'
        ? b.background.relPath.split('/').pop()!
        : null
    )
  }
  let bgEntries: string[] = []
  try {
    bgEntries = await fsp.readdir(backgroundsRoot)
  } catch {
    /* root not created yet */
  }
  for (const boardId of bgEntries) {
    const dir = join(backgroundsRoot, boardId)
    if (!keepByBoard.has(boardId)) {
      if (!(await olderThanFloor(dir))) continue
      try {
        await fsp.rm(dir, { recursive: true, force: true })
        summary.removedBackgroundEntries++
      } catch {
        /* next launch */
      }
      continue
    }
    const keep = keepByBoard.get(boardId)
    let files: string[] = []
    try {
      files = await fsp.readdir(dir)
    } catch {
      continue
    }
    for (const f of files) {
      if (f === keep) continue
      const stale = join(dir, f)
      if (!(await olderThanFloor(stale))) continue
      try {
        await fsp.rm(stale, { force: true })
        summary.removedBackgroundEntries++
      } catch {
        /* next launch */
      }
    }
  }

  return summary
}
