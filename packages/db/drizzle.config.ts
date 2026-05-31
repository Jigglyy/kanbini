import { defineConfig } from 'drizzle-kit'

// Generates migration SQL from src/schema.ts into ./drizzle (committed;
// applied at runtime by client.ts migrate-on-open). No DB credentials:
// `drizzle-kit generate` diffs the schema, it doesn't connect.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './drizzle',
  strict: true,
  verbose: true
})
