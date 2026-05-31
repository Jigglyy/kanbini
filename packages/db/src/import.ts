import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Db } from './client'
import { EXPORT_FORMAT_VERSION } from './export'
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
  project,
  template
} from './schema'

// M4-B · plain-text import. Pairs with `exportToFolder` (M4-A) to
// give us a lossless round-trip path. Pre-condition: a folder that
// exportToFolder wrote (kanbini.json + cards/*.md + attachments/).
//
// Strategy:
//   1. Read kanbini.json, validate the format version. Newer formats
//      should never silently downgrade - refuse with a clear error.
//   2. Read each cards/<id>.md and stitch it back onto the matching
//      row in memory (cards without an .md file keep description = null).
//   3. Wipe the DB inside a transaction: DELETE FROM project + template
//      cascades through every other table via the schema's ON DELETE
//      CASCADE chain (board → list → card → checklists/items/comments/
//      attachments/cardLabels, label → cardLabels, activity scoped to
//      board). FK enforcement stays ON throughout.
//   4. Re-insert in dependency order. Drizzle preserves epoch-ms
//      timestamps and boolean coercion is transparent.
//   5. Copy attachment files into `userDataDir/attachments/<id>/` so
//      kanbini-file:// URLs resolve again.
//
// Wipe + replace, not merge - "import" means "restore from snapshot".
// Merging two divergent histories needs separate UI (M4-F or later).

export interface ImportSummary {
  importedAt: number
  sourceRoot: string
  formatVersion: number
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
    descriptionsFromMd: number
    attachmentFilesCopied: number
  }
}

/** Minimal shape we read out of kanbini.json. The values themselves
 *  are passed straight back to drizzle inserts; the schema is the
 *  single source of validation. */
interface ParsedDump {
  schemaVersion: number
  formatVersion: number
  exportedAt: number
  projects: Array<typeof project.$inferInsert>
  boards: Array<typeof board.$inferInsert>
  lists: Array<typeof list.$inferInsert>
  cards: Array<typeof card.$inferInsert>
  labels: Array<typeof label.$inferInsert>
  cardLabels: Array<typeof cardLabel.$inferInsert>
  checklists: Array<typeof checklist.$inferInsert>
  checklistItems: Array<typeof checklistItem.$inferInsert>
  comments: Array<typeof comment.$inferInsert>
  attachments: Array<typeof attachment.$inferInsert>
  activities: Array<typeof activity.$inferInsert>
}

export async function importFromFolder(
  db: Db,
  userDataDir: string,
  sourceRoot: string
): Promise<ImportSummary> {
  // 1. Parse the JSON dump.
  const dumpPath = join(sourceRoot, 'kanbini.json')
  const raw = await fsp.readFile(dumpPath, 'utf8')
  const dump = JSON.parse(raw) as ParsedDump
  if (dump.formatVersion !== EXPORT_FORMAT_VERSION) {
    throw new Error(
      `import: format v${dump.formatVersion} but this build understands v${EXPORT_FORMAT_VERSION}`
    )
  }

  // 2. Stitch descriptions back from cards/<id>.md.
  const cardsDir = join(sourceRoot, 'cards')
  let descriptionsFromMd = 0
  for (const c of dump.cards) {
    if (!c.id) continue
    const mdPath = join(cardsDir, `${c.id}.md`)
    try {
      c.description = await fsp.readFile(mdPath, 'utf8')
      descriptionsFromMd++
    } catch (e: unknown) {
      const code = (e as { code?: string }).code
      if (code === 'ENOENT') {
        c.description = null
      } else {
        throw e
      }
    }
  }

  // 3 + 4. Wipe + re-insert in a single transaction so a partial
  //         import never corrupts the DB. better-sqlite3 transactions
  //         are synchronous, which is what we want here - file copies
  //         happen AFTER the transaction commits.
  db.transaction((tx) => {
    // CASCADE-clean wipe. Order doesn't matter for correctness because
    // each parent cascades to its children - but project + template
    // are the only two roots, so two DELETEs are enough.
    tx.delete(template).run()
    tx.delete(project).run()

    // Re-insert in dependency order. Drizzle .values() forwards every
    // field - including createdAt/updatedAt - so timestamps round-trip
    // exactly, defaults never override them.
    if (dump.projects.length > 0)
      tx.insert(project).values(dump.projects).run()
    if (dump.boards.length > 0) tx.insert(board).values(dump.boards).run()
    if (dump.labels.length > 0) tx.insert(label).values(dump.labels).run()
    if (dump.lists.length > 0) tx.insert(list).values(dump.lists).run()
    if (dump.cards.length > 0) tx.insert(card).values(dump.cards).run()
    if (dump.cardLabels.length > 0)
      tx.insert(cardLabel).values(dump.cardLabels).run()
    if (dump.checklists.length > 0)
      tx.insert(checklist).values(dump.checklists).run()
    if (dump.checklistItems.length > 0)
      tx.insert(checklistItem).values(dump.checklistItems).run()
    if (dump.comments.length > 0)
      tx.insert(comment).values(dump.comments).run()
    if (dump.attachments.length > 0)
      tx.insert(attachment).values(dump.attachments).run()
    if (dump.activities.length > 0)
      tx.insert(activity).values(dump.activities).run()
  })

  // 5. Copy attachment files into userDataDir mirroring the relPath
  //    column. We tolerate already-present files (a partial previous
  //    import) - overwriting is idempotent.
  let attachmentFilesCopied = 0
  for (const att of dump.attachments) {
    if (!att.relPath) continue
    const src = join(sourceRoot, att.relPath)
    const dest = join(userDataDir, att.relPath)
    try {
      await fsp.mkdir(dirname(dest), { recursive: true })
      await fsp.copyFile(src, dest)
      attachmentFilesCopied++
    } catch (e: unknown) {
      const code = (e as { code?: string }).code
      if (code === 'ENOENT') {
        // File missing in the export - the row stays, the file
        // doesn't. The renderer's broken-image fallback covers this;
        // worth surfacing in the summary so callers can act on it.
        continue
      }
      throw e
    }
  }

  // 5b. Copy board-background image files (ADR-0034). Mirror the
  //     attachments loop: iterate boards, find image-kind background
  //     rows, copy from export → userData. ENOENT tolerated for the
  //     same reason - a missing file leaves the board row pointing at
  //     a path that resolves to nothing; the renderer parses
  //     background defensively (zod safeParse → null on miss).
  for (const b of dump.boards) {
    const bg = (b as { background?: unknown }).background as
      | { kind?: string; relPath?: string }
      | null
      | undefined
    if (!bg || bg.kind !== 'image' || !bg.relPath) continue
    const src = join(sourceRoot, bg.relPath)
    const dest = join(userDataDir, bg.relPath)
    try {
      await fsp.mkdir(dirname(dest), { recursive: true })
      await fsp.copyFile(src, dest)
    } catch (e: unknown) {
      const code = (e as { code?: string }).code
      if (code === 'ENOENT') continue
      throw e
    }
  }

  return {
    importedAt: Date.now(),
    sourceRoot,
    formatVersion: dump.formatVersion,
    counts: {
      projects: dump.projects.length,
      boards: dump.boards.length,
      lists: dump.lists.length,
      cards: dump.cards.length,
      labels: dump.labels.length,
      cardLabels: dump.cardLabels.length,
      checklists: dump.checklists.length,
      checklistItems: dump.checklistItems.length,
      comments: dump.comments.length,
      attachments: dump.attachments.length,
      activities: dump.activities.length,
      descriptionsFromMd,
      attachmentFilesCopied
    }
  }
}
