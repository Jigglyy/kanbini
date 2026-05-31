import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type Database from 'better-sqlite3'
import { openDatabase, type Db } from '../client'

// Test helper: hand back a fresh :memory: DB with the real Drizzle
// migrations applied. Same code path the desktop app's `openDatabase`
// uses - same driver (better-sqlite3), same migration runner - so
// schema/migration bugs surface here, not in the wild.

const here = dirname(fileURLToPath(import.meta.url))
// `packages/db/src/__tests__/_setup.ts` → `packages/db/drizzle/`.
const MIGRATIONS = resolve(here, '../../drizzle')

export interface TestDb {
  db: Db
  /** Raw better-sqlite3 handle, exposed for the rare test that needs
   *  to plant an out-of-band value (e.g. simulate an older DB schema
   *  or a future-mode column value the current build's parser should
   *  soft-narrow). Prefer `db` (drizzle) for everything else - keeps
   *  tests black-box against the public surface. */
  sqlite: Database.Database
  close: () => void
}

/** Open a fresh in-memory DB with migrations applied. The returned
 *  `close()` releases the connection - call it from `afterEach` so
 *  test files don't leak handles. */
export function createTestDb(): TestDb {
  const { db, sqlite, close } = openDatabase({
    filePath: ':memory:',
    migrationsFolder: MIGRATIONS
  })
  return { db, sqlite, close }
}
