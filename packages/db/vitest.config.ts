import { defineConfig } from 'vitest/config'

// @kanbini/db tests run against an in-memory better-sqlite3 + the
// real Drizzle migrations on disk - same driver production uses, so
// schema changes / migration bugs surface here rather than after a
// release. Native module caveat: better-sqlite3 must be built against
// the Node ABI the test runner uses. A fresh `pnpm install` already
// is; if you ran `pnpm --filter @kanbini/desktop rebuild:native` to
// work on the app, re-run `pnpm rebuild better-sqlite3` before
// `pnpm test`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Each test file opens its own :memory: DB; running them in
    // parallel inside the same process is safe but slow on Windows
    // due to better-sqlite3 init cost. `pool: 'threads'` (default)
    // is fine.
    testTimeout: 10_000
  }
})
