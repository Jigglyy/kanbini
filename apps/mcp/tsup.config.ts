import { readFileSync, writeFileSync } from 'node:fs'
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
  // EVERYTHING non-builtin is bundled in - `@kanbini/shared` AND the
  // real runtime deps (zod, @modelcontextprotocol/sdk). tsup treats
  // `dependencies` as external by default, which was fine in dev
  // (apps/mcp/node_modules is right there) but shipped a packaged
  // `resources/mcp/index.js` with no node_modules beside it: the
  // server died on ERR_MODULE_NOT_FOUND before the MCP handshake and
  // every client reported CONNECTION_CLOSED. The whole point of this
  // bundle is that a client only needs one path, so bundle for real.
  noExternal: [/.*/],
  // Node decides ESM-vs-CJS from the nearest package.json. In dev
  // that's apps/mcp/package.json (`"type": "module"`); packaged, the
  // bundle sits alone under `resources/mcp/` with nothing above it,
  // so Node falls back to CommonJS and either warns-and-reparses
  // (newer Node) or throws on the first `import` (older Node). Drop a
  // one-key package.json next to the bundle so the module type is
  // never ambiguous. electron-builder's extraResources copy is
  // `**/*` from this dir, so it ships automatically.
  onSuccess: async () => {
    writeFileSync(
      resolve(here, 'dist/package.json'),
      JSON.stringify({ type: 'module' }, null, 2) + '\n',
      'utf8'
    )
  }
})
