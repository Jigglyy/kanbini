import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from './schema'

// Electron-agnostic on purpose (DESIGN §5): the caller supplies the
// file path and migrations folder. apps/desktop passes Electron's
// userData path; the headless MCP read-fallback can open the same file.

export type Db = BetterSQLite3Database<typeof schema>

export interface OpenOptions {
  /** SQLite file path, or ':memory:' for tests. */
  filePath: string
  /** Folder of generated Drizzle migrations (caller resolves it). */
  migrationsFolder: string
  /** Open read-only (headless MCP fallback). Skips migrations. */
  readonly?: boolean
}

export interface OpenResult {
  db: Db
  /** Escape hatch for pragmas/backup; the service layer uses `db`. */
  sqlite: Database.Database
  close: () => void
}

/**
 * Open (or create) the SQLite database: WAL, FK enforcement, and - for
 * read-write opens - migrate-on-open so the file is always at schema v1+.
 */
export function openDatabase(opts: OpenOptions): OpenResult {
  const sqlite = new Database(opts.filePath, {
    readonly: opts.readonly ?? false
  })

  if (!opts.readonly) {
    sqlite.pragma('journal_mode = WAL')
  }
  sqlite.pragma('foreign_keys = ON')

  const db = drizzle(sqlite, { schema })

  if (!opts.readonly) {
    migrate(db, { migrationsFolder: opts.migrationsFolder })
  }

  return { db, sqlite, close: () => sqlite.close() }
}
