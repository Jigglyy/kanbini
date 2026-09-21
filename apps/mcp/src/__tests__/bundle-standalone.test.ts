import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Packaging regression guard (v0.7.1 field bug).
//
// electron-builder copies `apps/mcp/dist` to `<resources>/mcp` and
// nothing else - no node_modules, and (before this fix) no
// package.json. tsup treats `dependencies` as external by default, so
// the shipped bundle still did `import ... from "zod"` and
// `"@modelcontextprotocol/sdk/..."`. Every install died with
// ERR_MODULE_NOT_FOUND the instant a client spawned it, which the
// client reported as the opaque `CONNECTION_CLOSED`.
//
// The rest of the MCP suite spawns the same dist/index.js from INSIDE
// the workspace, where pnpm's hoisted node_modules is always a couple
// of directories up - so it resolved fine and the suite stayed green
// while the shipped artifact was broken. The only honest test is to
// run the bundle from a directory that has no node_modules above it.

const here = dirname(fileURLToPath(import.meta.url))
const BUNDLE = resolve(here, '../../dist/index.js')
const DIST_PKG = resolve(here, '../../dist/package.json')

describe('packaged MCP bundle', () => {
  it('is built (run `pnpm --filter @kanbini/mcp run build`)', () => {
    expect(existsSync(BUNDLE)).toBe(true)
  })

  it('imports nothing but node builtins', () => {
    const src = readFileSync(BUNDLE, 'utf8')
    // Static `from "x"` specifiers surviving in the emitted ESM. A
    // bare specifier here is a dependency tsup left external, which
    // resolves in the workspace and fails everywhere else.
    const specifiers = [...src.matchAll(/\bfrom\s*"([^"]+)"/g)]
      .map((m) => m[1])
      .filter((v): v is string => v !== undefined)
    const external = [...new Set(specifiers)].filter(
      (spec) => !spec.startsWith('node:') && !isBuiltin(spec)
    )
    expect(external).toEqual([])
  })

  it('ships a package.json pinning the module type', () => {
    // Node picks ESM-vs-CJS from the nearest package.json. Under
    // `<resources>/mcp/` there is nothing above the bundle, so without
    // this marker Node falls back to CommonJS: newer Node warns on
    // stderr and reparses, older Node throws on the first `import`.
    expect(existsSync(DIST_PKG)).toBe(true)
    expect(JSON.parse(readFileSync(DIST_PKG, 'utf8')).type).toBe('module')
  })

  it('completes an MCP handshake with no node_modules in scope', async () => {
    // os.tmpdir() sits outside the repo, so nothing resolves upward.
    const dir = await mkdtemp(join(tmpdir(), 'kanbini-mcp-standalone-'))
    try {
      await copyFile(BUNDLE, join(dir, 'index.js'))
      await copyFile(DIST_PKG, join(dir, 'package.json'))

      const client = new Client(
        { name: 'standalone-probe', version: '0.0.0' },
        { capabilities: {} }
      )
      // No KANBINI_USERDATA_OVERRIDE and no app running: the server
      // must still come up and list tools (reads fall back to the
      // on-disk export, writes error at call time). What we are
      // pinning is that the process survives to the handshake at all.
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(dir, 'index.js')],
        cwd: dir
      })
      await client.connect(transport)
      try {
        const { tools } = await client.listTools()
        expect(tools.length).toBeGreaterThan(0)
        expect(tools.map((t) => t.name)).toContain('kanbini_list_boards')
      } finally {
        await client.close()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

/** Node builtins are also importable unprefixed ("fs", "path"). tsup
 *  emits the unprefixed form for some, so check both spellings. */
function isBuiltin(specifier: string): boolean {
  const root = specifier.split('/')[0] ?? specifier
  return BUILTINS.has(root)
}

const BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net',
  'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'timers', 'tls',
  'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads',
  'zlib'
])
