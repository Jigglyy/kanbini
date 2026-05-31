import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyMutation,
  createAttachment,
  exportToFolder,
  importFromFolder,
  openDatabase,
  seedSampleData,
  schema
} from '@kanbini/db'
import { newId } from '@kanbini/shared'

// M4-C · round-trip test.
//
// Runs against an in-memory DB seeded with sample data + one of every
// "interesting" row kind (description, comment, AI comment, attachment
// with a real file, checklist with items, mutation activity). Then:
//
//   1. export to folder A
//   2. wipe DB + import from A
//   3. re-export to folder B
//   4. assert A and B are byte-identical
//
// If the round-trip is lossless AND deterministic, A and B match
// exactly. Any divergence (missing column, sort flake, default kicking
// in over a stored timestamp) shows up as a single failing assertion.
//
// Runs under Electron because better-sqlite3 here is built for the
// Electron ABI (ADR-0012). Invoked via:
//   pnpm --filter @kanbini/desktop run test:roundtrip
// which builds main + launches `electron out/main/index.js
// --round-trip-test`.

export async function runRoundTripTest(
  migrationsFolder: string
): Promise<number> {
  const tmpUserData = await fsp.mkdtemp(join(tmpdir(), 'kanbini-rt-'))
  console.log(`[round-trip] workdir: ${tmpUserData}`)
  await fsp.mkdir(join(tmpUserData, 'attachments'), { recursive: true })

  const { db, close } = openDatabase({
    filePath: ':memory:',
    migrationsFolder
  })

  let exitCode = 0
  try {
    seedSampleData(db)

    // Pick the first card from the first list to enrich with one of
    // every kind of attached data.
    const firstBoard = db
      .select()
      .from(schema.board)
      .all()[0]
    if (!firstBoard) throw new Error('seed produced no boards')
    const firstList = db
      .select()
      .from(schema.list)
      .all()[0]
    if (!firstList) throw new Error('seed produced no lists')
    const firstCard = db
      .select()
      .from(schema.card)
      .all()[0]
    if (!firstCard) throw new Error('seed produced no cards')

    // (a) description (→ exercises cards/<id>.md round-trip)
    applyMutation(db, {
      type: 'card.update',
      id: firstCard.id,
      patch: {
        description:
          'Round-trip coverage card.\n\n**Bold** + `inline code` + a [link](https://example.test).\n\n- A\n- B\n- C\n'
      }
    })

    // (b) human + AI comments
    applyMutation(db, {
      type: 'comment.create',
      cardId: firstCard.id,
      body: 'human comment'
    })
    applyMutation(db, {
      type: 'comment.create',
      cardId: firstCard.id,
      body: 'AI comment',
      author: 'ai'
    })

    // (c) label diff activity (added)
    const firstLabel = db
      .select()
      .from(schema.label)
      .all()[0]
    if (firstLabel) {
      applyMutation(db, {
        type: 'card.setLabels',
        id: firstCard.id,
        labelIds: [firstLabel.id]
      })
    }

    // (d) move + completion activity
    const otherList = db
      .select()
      .from(schema.list)
      .all()
      .find((l) => l.id !== firstCard.listId)
    if (otherList) {
      applyMutation(db, {
        type: 'card.move',
        id: firstCard.id,
        toListId: otherList.id,
        beforeId: null,
        afterId: null
      })
    }
    applyMutation(db, {
      type: 'card.update',
      id: firstCard.id,
      patch: { completed: true }
    })

    // (e) attachment row + real file on disk
    const attId = newId()
    const filename = 'round-trip-fixture.txt'
    const relPath = `attachments/${attId}/${filename}`
    const fixtureBody = 'round-trip fixture bytes - checked for byte-identical re-export'
    await fsp.mkdir(join(tmpUserData, 'attachments', attId), { recursive: true })
    await fsp.writeFile(join(tmpUserData, relPath), fixtureBody, 'utf8')
    createAttachment(db, {
      id: attId,
      cardId: firstCard.id,
      filename,
      relPath,
      mime: 'text/plain',
      size: Buffer.byteLength(fixtureBody, 'utf8')
    })

    // 1. Export to A.
    const exportA = join(tmpUserData, 'export-a')
    const summaryA = await exportToFolder(db, tmpUserData, exportA)
    console.log(
      `[round-trip] export A → ${summaryA.counts.cards} cards, ` +
        `${summaryA.counts.activities} activities, ` +
        `${summaryA.counts.attachments} attachments`
    )

    // 2. Wipe + import from A.
    const importSummary = await importFromFolder(db, tmpUserData, exportA)
    console.log(
      `[round-trip] import ← ${importSummary.counts.descriptionsFromMd} ` +
        `descriptions, ${importSummary.counts.attachmentFilesCopied} files`
    )

    // 3. Re-export to B.
    const exportB = join(tmpUserData, 'export-b')
    await exportToFolder(db, tmpUserData, exportB)

    // 4. Byte-identical comparison.
    const drift = await diffFolders(exportA, exportB)
    if (drift) {
      console.error(`[round-trip] FAIL · ${drift}`)
      exitCode = 1
    } else {
      console.log('[round-trip] PASS · export A === export B byte-for-byte')
    }
  } catch (err) {
    console.error('[round-trip] ERROR ·', err)
    exitCode = 1
  } finally {
    close()
    await fsp.rm(tmpUserData, { recursive: true, force: true })
  }
  return exitCode
}

/** Return null on equality, or a one-line description of the first
 *  divergence. Folder layout AND file contents must match - except
 *  for kanbini.json's `exportedAt`, which is wall-clock and always
 *  differs between two exports of the same state. */
async function diffFolders(a: string, b: string): Promise<string | null> {
  const aFiles = await listFiles(a)
  const bFiles = await listFiles(b)
  if (aFiles.length !== bFiles.length) {
    return `file count: A=${aFiles.length} vs B=${bFiles.length}`
  }
  for (let i = 0; i < aFiles.length; i++) {
    if (aFiles[i] !== bFiles[i]) {
      return `entry [${i}]: A="${aFiles[i]}" vs B="${bFiles[i]}"`
    }
    const ax = await fsp.readFile(join(a, aFiles[i]!))
    const bx = await fsp.readFile(join(b, bFiles[i]!))
    if (aFiles[i] === 'kanbini.json') {
      // Normalize the wall-clock timestamp before comparing - the
      // round-trip guarantees the DUMP is identical, not the moment.
      const an = normalizeKanbiniJson(ax.toString('utf8'))
      const bn = normalizeKanbiniJson(bx.toString('utf8'))
      if (an !== bn) {
        return `content mismatch in ${aFiles[i]} after exportedAt normalization`
      }
      continue
    }
    if (!ax.equals(bx)) {
      return `content mismatch in ${aFiles[i]} (A=${ax.length}b, B=${bx.length}b)`
    }
  }
  return null
}

function normalizeKanbiniJson(text: string): string {
  const obj = JSON.parse(text) as { exportedAt?: number }
  obj.exportedAt = 0
  return JSON.stringify(obj, null, 2)
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(rel: string): Promise<void> {
    const entries = await fsp.readdir(join(root, rel), {
      withFileTypes: true
    })
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await walk(childRel)
      else out.push(childRel)
    }
  }
  await walk('')
  return out.sort()
}
