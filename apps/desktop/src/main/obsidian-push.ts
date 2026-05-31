import { promises as fsp } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { ObsidianPushResult } from '@kanbini/shared'
import {
  buildNote,
  chooseFilename,
  extractKanbiniId,
  slugify
} from '@kanbini/shared'
import { getBoardView, listBoards, type Db } from '@kanbini/db'

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
  if (
    targetRoot !== vaultRoot + sep + subfolder &&
    !targetRoot.startsWith(vaultRoot + sep)
  ) {
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

  const boards = listBoards(db)
  let cardCount = 0
  let written = 0
  let skippedForeign = 0
  const warnings: string[] = []

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
      }
    }
  }

  return {
    pushedAt: startedAt,
    boardCount: boards.length,
    cardCount,
    written,
    skippedForeign,
    warnings
  }
}
