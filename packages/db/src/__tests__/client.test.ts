import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createTestDb } from './_setup'

// Smoke test for the migration pipeline. If migrations don't apply
// cleanly to a fresh DB, every other test breaks too - keep this
// at the top of the test order so the failure mode is obvious.

describe('openDatabase :memory: + migrate', () => {
  it('runs every migration and lands on the expected schema', () => {
    const { db, close } = createTestDb()
    try {
      const tables = db
        .all<{ name: string }>(
          sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name`
        )
        .map((r) => r.name)
      // 12 domain tables (schema v1) + later additions; just spot-
      // check the load-bearing ones so adding a future migration
      // doesn't churn this test on every drizzle run.
      expect(tables).toEqual(
        expect.arrayContaining([
          'project',
          'board',
          'list',
          'card',
          'label',
          'card_label',
          'checklist',
          'checklist_item',
          'comment',
          'attachment',
          'activity'
        ])
      )
    } finally {
      close()
    }
  })

  it('has foreign_keys ON', () => {
    const { db, close } = createTestDb()
    try {
      // PRAGMA foreign_keys returns a single column named "foreign_keys".
      const rows = db.all<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`)
      expect(rows[0]?.foreign_keys).toBe(1)
    } finally {
      close()
    }
  })
})
