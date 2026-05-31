import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Renderer test runner (ADR-0044, test-coverage slice c). JSDOM env so
// React + Testing Library + happy-dom-free assertions work. The `@/`
// alias mirrors what `electron.vite.config.ts` sets for the renderer's
// real build, so imports inside the source under test resolve the same
// way.
//
// Why a stand-alone vitest config (not the renderer's existing
// electron-vite config): electron-vite expects an Electron context
// (main + preload + renderer roles), which is overkill for unit tests.
// Vitest only needs the resolve.alias + a couple of plugins it
// auto-discovers (the React JSX transform, etc.). Same alias keeps
// every `@/lib/utils` import working without extra mocks.
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  },
  test: {
    environment: 'jsdom',
    globals: false,
    // Setup file installs jest-dom matchers + a clean window.kanbini
    // mock per-test (see src/__tests__/_setup.ts).
    setupFiles: ['./src/__tests__/_setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // Disable CSS handling - we don't render styles in JSDOM, importing
    // `index.css` just slows tests down and pulls in Tailwind at-rules
    // Vitest doesn't process. Components are asserted by structure +
    // text, not by computed styles.
    css: false,
    // Each test file gets its own jsdom - keeps localStorage / window
    // / DOM isolated. Cheap enough on a renderer with ~5 test files.
    isolate: true
  }
})
