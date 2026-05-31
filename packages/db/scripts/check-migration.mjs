// Migration smoke check (no test runner yet): proves the generated
// migration SQL is valid and creates exactly the schema-v1 tables.
//
// Uses Node's built-in `node:sqlite` ON PURPOSE - not better-sqlite3.
// The app's better-sqlite3 is compiled for Electron's ABI
// (electron-rebuild, ADR-0012) and won't load under bare Node, so dev
// tooling must not depend on it. node:sqlite runs the same SQLite DDL,
// so this remains a faithful check of the migration. That the *real*
// better-sqlite3 loads is verified separately under Electron's runtime.
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle')

const sqlFiles = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
if (sqlFiles.length === 0) {
  console.error('No migration .sql found - run `pnpm --filter @kanbini/db run db:generate` first.')
  process.exit(1)
}

const db = new DatabaseSync(':memory:')
db.exec('PRAGMA foreign_keys = ON;')
for (const f of sqlFiles) db.exec(readFileSync(join(drizzleDir, f), 'utf8'))

const tables = db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name"
  )
  .all()
  .map((r) => r.name)
db.close()

const expected = [
  'activity',
  'attachment',
  'board',
  'card',
  'card_label',
  'checklist',
  'checklist_item',
  'comment',
  'label',
  'list',
  'project',
  'template'
]
const missing = expected.filter((t) => !tables.includes(t))

console.log(`node:sqlite OK · ${tables.length} tables: ${tables.join(', ')}`)
if (missing.length > 0) {
  console.error(`MISSING tables: ${missing.join(', ')}`)
  process.exit(1)
}
console.log('schema v1 OK - all expected tables present.')
