import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import { asc } from 'drizzle-orm'
import type { Db } from './client'
import {
  activity,
  attachment,
  board,
  card,
  cardLabel,
  checklist,
  checklistItem,
  comment,
  label,
  list,
  project
} from './schema'

// M4-A · plain-text export.
//
// Layout under <destRoot>:
//   kanbini.json                          schema-versioned dump (everything but
//                                         card descriptions) - single source of
//                                         truth for the importer
//   cards/<card-id>.md                    each card's description body. Cards
//                                         with a null/empty description get no
//                                         file. id-keyed paths stay stable
//                                         across rename so re-exports diff
//                                         cleanly in git.
//   attachments/<attachment-id>/<filename>  file copies, mirroring the relPath
//                                         stored on the attachment row.
//
// Atomic swap: stage to `<destRoot>.staging`, move the existing folder to
// `<destRoot>.backup`, move staging into place, then rm the backup. A crash
// between any two steps leaves either the previous or the new export intact -
// never a half-written one.

/** Bumped whenever the on-disk layout shifts. The importer uses this to
 *  refuse exports it can't read. Today: schema v1, layout v1. */
export const EXPORT_FORMAT_VERSION = 1 as const

export interface ExportSummary {
  exportedAt: number
  destRoot: string
  formatVersion: typeof EXPORT_FORMAT_VERSION
  counts: {
    projects: number
    boards: number
    lists: number
    cards: number
    labels: number
    cardLabels: number
    checklists: number
    checklistItems: number
    comments: number
    attachments: number
    activities: number
  }
}

/**
 * Write the full DB + attachments to a plain-text snapshot.
 *
 * `userDataDir` is the parent of `userDataDir/attachments/` - used to
 * resolve each attachment row's `relPath` into an absolute source path.
 */
export async function exportToFolder(
  db: Db,
  userDataDir: string,
  destRoot: string
): Promise<ExportSummary> {
  const stage = `${destRoot}.staging`
  const backup = `${destRoot}.backup`

  // 1. Clear any leftover staging from a previous crash.
  await fsp.rm(stage, { recursive: true, force: true })
  await fsp.mkdir(stage, { recursive: true })

  // 2. Dump every table. Sort by id everywhere (UUIDv7 = time-sortable)
  //    so consecutive exports of an unchanged DB produce byte-identical
  //    files - friendly for git-tracking the export folder.
  const projects = db.select().from(project).orderBy(asc(project.id)).all()
  const boards = db.select().from(board).orderBy(asc(board.id)).all()
  const lists = db.select().from(list).orderBy(asc(list.id)).all()
  const cards = db.select().from(card).orderBy(asc(card.id)).all()
  const labels = db.select().from(label).orderBy(asc(label.id)).all()
  const cardLabels = db
    .select()
    .from(cardLabel)
    .orderBy(asc(cardLabel.cardId), asc(cardLabel.labelId))
    .all()
  const checklists = db
    .select()
    .from(checklist)
    .orderBy(asc(checklist.id))
    .all()
  const checklistItems = db
    .select()
    .from(checklistItem)
    .orderBy(asc(checklistItem.id))
    .all()
  const comments = db.select().from(comment).orderBy(asc(comment.id)).all()
  const attachments = db
    .select()
    .from(attachment)
    .orderBy(asc(attachment.id))
    .all()
  const activities = db.select().from(activity).orderBy(asc(activity.id)).all()

  const exportedAt = Date.now()
  const dump = {
    schemaVersion: 1, // matches @kanbini/shared SCHEMA_VERSION
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt,
    projects,
    boards,
    lists,
    // Description body moves to cards/<id>.md; null out the column in
    // JSON to keep the source of truth in one place per card.
    cards: cards.map((c) => ({ ...c, description: null })),
    labels,
    cardLabels,
    checklists,
    checklistItems,
    comments,
    attachments,
    activities
  }

  await fsp.writeFile(
    join(stage, 'kanbini.json'),
    JSON.stringify(dump, null, 2),
    'utf8'
  )

  // 3. Per-card description .md files. Skip cards with no description.
  const cardsDir = join(stage, 'cards')
  await fsp.mkdir(cardsDir, { recursive: true })
  for (const c of cards) {
    if (c.description && c.description.length > 0) {
      await fsp.writeFile(join(cardsDir, `${c.id}.md`), c.description, 'utf8')
    }
  }

  // 4. Stage attachment files. Each row's relPath is
  //    "attachments/<id>/<filename>", anchored to userDataDir.
  //    A missing source file (deleted out from under us, or never
  //    written) must NOT abort the whole snapshot - the row still
  //    exports, only its file is skipped. The importer already
  //    tolerates ENOENT the same way; without this an export (and so
  //    the on-quit auto-backup) breaks entirely on one orphaned row.
  //
  //    Reuse: attachment files are content-immutable (written once
  //    under their id), but the export used to re-copy every byte on
  //    every run - the on-quit auto-backup got slower with each
  //    attachment added. When the PREVIOUS export already holds a
  //    copy with the same size + mtime as the source, hardlink it
  //    into the staging dir instead (instant, still byte-identical;
  //    the atomic-swap rename keeps inodes, and removing the backup
  //    later only drops a link). Fresh copies get the source's mtime
  //    stamped on so the NEXT export can match them - copyFile does
  //    not preserve timestamps on its own. Any reuse failure falls
  //    back to a plain copy.
  const stageFile = async (src: string, dest: string, prev: string) => {
    let srcStat
    try {
      srcStat = await fsp.stat(src)
    } catch (e: unknown) {
      if ((e as { code?: string }).code !== 'ENOENT') throw e
      return false
    }
    try {
      const prevStat = await fsp.stat(prev)
      // NTFS keeps sub-ms timestamps; utimes round-trips within ~1 ms.
      if (
        prevStat.size === srcStat.size &&
        Math.abs(prevStat.mtimeMs - srcStat.mtimeMs) < 2
      ) {
        await fsp.link(prev, dest)
        return true
      }
    } catch {
      /* no previous copy / hardlink unsupported - fall through */
    }
    await fsp.copyFile(src, dest)
    try {
      await fsp.utimes(dest, srcStat.atime, srcStat.mtime)
    } catch {
      /* timestamp stamping is an optimisation, never fatal */
    }
    return true
  }

  for (const att of attachments) {
    const src = join(userDataDir, att.relPath)
    const dest = join(stage, att.relPath)
    const prev = join(destRoot, att.relPath)
    await fsp.mkdir(dirname(dest), { recursive: true })
    const ok = await stageFile(src, dest, prev)
    if (!ok) {
      console.warn(`[export] attachment file missing, skipped: ${att.relPath}`)
    }
  }

  // 4b. Stage board-background image files (ADR-0034). Each board's
  //     `background` column is a JSON discriminated union; image-kind
  //     entries carry a userData-relative `relPath` under
  //     `board-backgrounds/`. Color + gradient backgrounds need no
  //     file copy - the data already rides in kanbini.json. Same
  //     ENOENT tolerance + previous-export reuse as attachments.
  for (const b of boards) {
    const bg = b.background as { kind?: string; relPath?: string } | null
    if (!bg || bg.kind !== 'image' || !bg.relPath) continue
    const src = join(userDataDir, bg.relPath)
    const dest = join(stage, bg.relPath)
    const prev = join(destRoot, bg.relPath)
    await fsp.mkdir(dirname(dest), { recursive: true })
    const ok = await stageFile(src, dest, prev)
    if (!ok) {
      console.warn(`[export] board background missing, skipped: ${bg.relPath}`)
    }
  }

  // 5. Atomic swap. If a previous export exists, move it aside first so
  //    we can roll back on any rename failure.
  let backupCreated = false
  try {
    try {
      await fsp.rename(destRoot, backup)
      backupCreated = true
    } catch (e: unknown) {
      // ENOENT = no previous export, fine. Anything else propagates.
      const code = (e as { code?: string }).code
      if (code !== 'ENOENT') throw e
    }
    await fsp.rename(stage, destRoot)
    if (backupCreated) {
      await fsp.rm(backup, { recursive: true, force: true })
    }
  } catch (err) {
    // Roll back: put the backup back if we already moved it.
    if (backupCreated) {
      try {
        await fsp.rm(destRoot, { recursive: true, force: true })
        await fsp.rename(backup, destRoot)
      } catch {
        /* leave the .backup folder for manual recovery */
      }
    }
    throw err
  }

  return {
    exportedAt,
    destRoot,
    formatVersion: EXPORT_FORMAT_VERSION,
    counts: {
      projects: projects.length,
      boards: boards.length,
      lists: lists.length,
      cards: cards.length,
      labels: labels.length,
      cardLabels: cardLabels.length,
      checklists: checklists.length,
      checklistItems: checklistItems.length,
      comments: comments.length,
      attachments: attachments.length,
      activities: activities.length
    }
  }
}
