import { defineConfig } from 'vitest/config'

// @kanbini/shared is pure TS - zod schemas + tiny id/order utils - so
// the default Node environment is exactly what we want. Tests live
// next to their subject in src/__tests__/<name>.test.ts.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
