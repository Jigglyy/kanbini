import { promises as fsp } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { ObsidianPushResult } from '@kanbini/shared'
import {
  buildNote,
  chooseFilename,
  extractKanbiniId,
  shouldPruneNote,
  slugify
} from '@kanbini/shared'
import { getBoardView, listBoards, listCardIds, type Db } from '@kanbini/db'

// ADR-0042 · one-way push of every card into an Obsidian vault as
// individual `.md` notes with YAML frontmatter. Pure-write: vault
// content is NEVER read for cross-direction sync. The only read we
// do is parsing the leading frontmatter block of an existing file
// at the target path so we can tell "this is one of our notes,
// overwrite it" vs "this is the user's file, skip it for safety."
//
// Main owns this code because:
//   - the vault path lives outside `userData` (first FS write the
//     app does outside its sandbox) - keeping the trust boundary
//     in main means the renderer can't forge a path.
//   - reading the board state requires the SQLite handle, which
//     only main has.
//
// The pure serialization + slugging + foreign-file detection helpers
// live in `@kanbini/shared/obsidian` so they're testable in the
// existing Vitest harness without touching disk.

export async function pushToObsidianVault(opts: {
  db: Db
  vaultPath: string
  subfolder: string
}): Promise<ObsidianPushResult> {
  const { db, vaultPath, subfolder } = opts
  const startedAt = Date.now()

  // Resolve + lock down the destination root: refuse to write outside
  // `<vaultPath>/<subfolder>`. Belt + braces against a malicious
  // subfolder string with `..` traversal (the renderer already
  // length-validates, but main is the trust boundary).
  const vaultRoot = resolve(vaultPath)
  const targetRoot = resolve(vaultRoot, subfolder)
  // An empty / '.' subfolder resolves to the vault root itself. That
  // used to fall into the traversal branch below and throw a
  // misleading "would write outside the vault" - name the real
  // problem instead (a dedicated subfolder is required so the
  // foreign-file safety model has a clear ownership boundary).
  if (targetRoot === vaultRoot) {
    throw new Error(
      'Pick a subfolder inside the vault - pushing straight into the vault root is not supported.'
    )
  }
  if (!targetRoot.startsWith(vaultRoot + sep)) {
    throw new Error(
      `Subfolder "${subfolder}" would write outside the vault. Refusing.`
    )
  }

  // Confirm the vault path actually exists + is a directory. Without
  // this the first mkdir would create the vault from scratch, which
  // is probably not what the user meant ("you picked the wrong
  // folder, here's a fresh one" is worse than "we refused").
  let vaultStat
  try {
    vaultStat = await fsp.stat(vaultRoot)
  } catch {
    throw new Error(`Vault folder not found at ${vaultRoot}.`)
  }
  if (!vaultStat.isDirectory()) {
    throw new Error(`Vault path is not a directory: ${vaultRoot}.`)
  }
  await fsp.mkdir(targetRoot, { recursive: true })

  // Archived boards are skipped - their notes stay as-is in the vault
  // (the prune below keeps them because their card ids are still
  // live), they just stop receiving updates until un-archived.
  const boards = listBoards(db).filter((b) => !b.archived)
  let cardCount = 0
  let written = 0
  let skippedForeign = 0
  const warnings: string[] = []
  // Card id → the absolute path written THIS push. Drives the stale-
  // note prune: a note we own whose id was written elsewhere this run
  // is the old copy of a renamed card / moved board folder.
  const writtenPathById = new Map<string, string>()

  for (const summary of boards) {
    const view = getBoardView(db, summary.id)
    if (!view) continue
    const boardDir = join(targetRoot, slugify(view.board.name))
    await fsp.mkdir(boardDir, { recursive: true })

    // Track filenames we've claimed inside THIS push so collision
    // suffixes are deterministic across the run (we own this dir
    // for the duration of the push).
    const taken = new Set<string>()
    for (const list of view.lists) {
      for (const card of list.cards) {
        cardCount++
        const baseSlug = slugify(card.title)
        const filename = chooseFilename(baseSlug, taken)
        taken.add(filename)
        const absPath = join(boardDir, filename)

        // Safety check before any write: if a file already exists
        // at the target path and DOESN'T carry our kanbini.id, it
        // belongs to the user (or a different tool). Skip + warn
        // rather than clobber. A file with a DIFFERENT kanbini.id
        // is also foreign - different card stole this slug first.
        try {
          const existing = await fsp.readFile(absPath, 'utf8')
          const claimed = extractKanbiniId(existing)
          if (claimed === null) {
            skippedForeign++
            if (warnings.length < 20) {
              warnings.push(
                `Left alone: ${absPath} (no kanbini.id frontmatter)`
              )
            }
            continue
          }
          if (claimed !== card.id) {
            skippedForeign++
            if (warnings.length < 20) {
              warnings.push(
                `Left alone: ${absPath} (owned by a different Kanbini card)`
              )
            }
            continue
          }
          // Same-id match → ours, safe to overwrite.
        } catch {
          // ENOENT - file doesn't exist yet, regular write path.
        }

        const note = buildNote({
          card,
          list,
          board: view.board,
          labels: view.labels
        })
        // Two-step atomic write: temp file then rename. Same pattern
        // as the M4-A export - the user never sees a half-written
        // note if the app crashes mid-flush.
        const tmpPath = `${absPath}.tmp`
        await fsp.mkdir(dirname(absPath), { recursive: true })
        await fsp.writeFile(tmpPath, note, 'utf8')
        await fsp.rename(tmpPath, absPath)
        written++
        writtenPathById.set(card.id, absPath)
      }
    }
  }

  // Prune stale notes WE own. Renames and deletes used to accumulate
  // zombie copies forever (a renamed card got a fresh slug, the old
  // file kept its kanbini.id and just sat there). Walk the target
  // subfolder only - never the rest of the vault - and apply the
  // conservative shouldPruneNote rule: foreign files are untouched,
  // live-but-not-written ids (archived boards, foreign-collision
  // skips) are kept. This reads frontmatter, which is the same class
  // of ownership check ADR-0042 already allows - still strictly
  // one-way, vault content never feeds back into the DB.
  const liveCardIds = new Set(listCardIds(db))
  let pruned = 0
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
        continue
      }
      if (!entry.name.endsWith('.md')) continue
      let id: string | null
      try {
        id = extractKanbiniId(await fsp.readFile(abs, 'utf8'))
      } catch {
        continue
      }
      if (!shouldPruneNote(id, liveCardIds, writtenPathById, abs)) continue
      try {
        await fsp.rm(abs, { force: true })
        pruned++
      } catch {
        if (warnings.length < 20) {
          warnings.push(`Could not remove stale note: ${abs}`)
        }
      }
    }
  }
  await walk(targetRoot)

  return {
    pushedAt: startedAt,
    boardCount: boards.length,
    cardCount,
    written,
    skippedForeign,
    warnings,
    pruned
  }
}
