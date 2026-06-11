import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsup'

// The MCP server reports the PRODUCT version - the desktop app's
// (apps/desktop/package.json is the one the release chore bumps; the
// other workspaces sit at 0.0.0). Inlined at build time so the
// packaged bundle never needs a package.json sitting next to it.
const here = dirname(fileURLToPath(import.meta.url))
const desktopPkg = JSON.parse(
  readFileSync(resolve(here, '../desktop/package.json'), 'utf8')
) as { version: string }

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
  define: {
    __KANBINI_VERSION__: JSON.stringify(desktopPkg.version)
  },
  // tsup respects the `bin` field - adding a shebang here lets it run
  // as `./dist/index.js` (used by the Claude Code .mcp.json snippet).
  banner: { js: '#!/usr/bin/env node' },
  // @modelcontextprotocol/sdk + zod are bundled (single-file).
  noExternal: ['@kanbini/shared']
})
