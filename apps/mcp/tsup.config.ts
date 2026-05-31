import { defineConfig } from 'tsup'

// Single-file ESM bundle for the MCP stdio server. Bundling
// @kanbini/shared in (instead of leaving it external) keeps the
// runtime entry self-contained so Claude Desktop / Claude Code only
// need to know one path. Node 18+ for built-in fetch.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node18',
  outDir: 'dist',
  clean: true,
  shims: false,
  splitting: false,
  sourcemap: true,
  // tsup respects the `bin` field - adding a shebang here lets it run
  // as `./dist/index.js` (used by the Claude Code .mcp.json snippet).
  banner: { js: '#!/usr/bin/env node' },
  // @modelcontextprotocol/sdk + zod are bundled (single-file).
  noExternal: ['@kanbini/shared']
})
