import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MCP_SERVER_POINTER_FILE } from '@kanbini/shared'
import { startFakeChannel, type FakeChannel } from './_fake-channel'

// The Claude Code plugin (plugins/kanbini) and its marketplace entry.
// The plugin has no package of its own, so its tests live here, next to
// the server it launches:
//   • manifest + marketplace shape, and the plugin version tracking the
//     app version (a release bump that forgets the plugin fails here)
//   • every tool a skill names exists on the real server
//   • the launcher, end to end: pointer file -> real MCP bundle -> fake
//     control channel, over stdio, exactly as Claude Code spawns it
//   • the launcher's failure messages (no pointer, bad pointer, a
//     command that no longer exists)
//   • the server exits when its client hangs up, even after a request

const here = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(here, '../../../..')
const PLUGIN = join(REPO, 'plugins', 'kanbini')
const LAUNCHER = join(PLUGIN, 'server', 'launch.mjs')
const SERVER_PATH = resolve(here, '../../dist/index.js')

if (!existsSync(SERVER_PATH)) {
  throw new Error(
    `MCP bundle missing at ${SERVER_PATH}. Run \`pnpm --filter @kanbini/mcp run build\` first.`
  )
}

const readJson = <T = Record<string, unknown>>(path: string): T =>
  JSON.parse(readFileSync(path, 'utf8')) as T

/** `key: value` pairs from a SKILL.md frontmatter block. */
function frontmatter(path: string): Record<string, string> {
  const text = readFileSync(path, 'utf8')
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) throw new Error(`${path} has no frontmatter`)
  const out: Record<string, string> = {}
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([a-z-]+):\s*(.*)$/.exec(line)
    if (kv) out[kv[1]!] = kv[2]!.replace(/^"(.*)"$/, '$1')
  }
  return out
}

const skillDirs = readdirSync(join(PLUGIN, 'skills'))
const skillPath = (dir: string): string => join(PLUGIN, 'skills', dir, 'SKILL.md')

describe('plugin manifest + marketplace', () => {
  it('names the plugin kanbini and tracks the app version', () => {
    const manifest = readJson<{ name: string; version: string; license: string }>(
      join(PLUGIN, '.claude-plugin', 'plugin.json')
    )
    const app = readJson<{ version: string }>(
      join(REPO, 'apps', 'desktop', 'package.json')
    )
    expect(manifest.name).toBe('kanbini')
    expect(manifest.license).toBe('MIT')
    // Bump plugins/kanbini/.claude-plugin/plugin.json with the app.
    expect(manifest.version).toBe(app.version)
  })

  it('is listed in the repo marketplace at its relative path', () => {
    const market = readJson<{
      name: string
      plugins: Array<{ name: string; source: string }>
    }>(join(REPO, '.claude-plugin', 'marketplace.json'))
    expect(market.name).toBe('kanbini')
    const entry = market.plugins.find((p) => p.name === 'kanbini')
    expect(entry?.source).toBe('./plugins/kanbini')
    expect(existsSync(resolve(REPO, entry!.source, '.claude-plugin', 'plugin.json'))).toBe(true)
  })

  it('runs the bundled launcher with node', () => {
    const cfg = readJson<{
      mcpServers: Record<string, { command: string; args: string[] }>
    }>(join(PLUGIN, '.mcp.json'))
    expect(cfg.mcpServers.kanbini).toEqual({
      command: 'node',
      args: ['${CLAUDE_PLUGIN_ROOT}/server/launch.mjs']
    })
    expect(existsSync(LAUNCHER)).toBe(true)
  })

  it('reads the same pointer file name the app writes', () => {
    expect(readFileSync(LAUNCHER, 'utf8')).toContain(
      `const POINTER_FILE = '${MCP_SERVER_POINTER_FILE}'`
    )
  })

  it('gives every skill a name and a description', () => {
    expect(skillDirs.sort()).toEqual(['agenda', 'kanbini', 'log', 'new-card'])
    for (const dir of skillDirs) {
      const fm = frontmatter(skillPath(dir))
      expect(fm.name, dir).toBe(dir)
      expect(fm.description?.length, dir).toBeGreaterThan(20)
    }
  })

  it('keeps the conventions skill out of the slash menu and the rest manual', () => {
    expect(frontmatter(skillPath('kanbini'))['user-invocable']).toBe('false')
    for (const dir of ['agenda', 'new-card', 'log']) {
      expect(frontmatter(skillPath(dir))['disable-model-invocation'], dir).toBe('true')
    }
  })
})

describe('launcher, end to end', () => {
  let channel: FakeChannel
  let client: Client
  let stderr = ''

  beforeAll(async () => {
    channel = await startFakeChannel()
    // What main writes on launch, pointed at the freshly built bundle.
    await writeFile(
      join(channel.userDataDir, MCP_SERVER_POINTER_FILE),
      JSON.stringify({
        command: process.execPath,
        args: [SERVER_PATH],
        version: 'test',
        writtenAt: Date.now()
      })
    )
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [LAUNCHER],
      env: { ...process.env, KANBINI_USERDATA_OVERRIDE: channel.userDataDir },
      stderr: 'pipe'
    })
    transport.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    client = new Client({ name: 'kanbini-plugin-test', version: '0.0.0' })
    await client.connect(transport)
  }, 30_000)

  afterAll(async () => {
    await client?.close().catch(() => {})
    await channel?.close()
  })

  it('serves the real tool set through the pointer', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['kanbini_list_boards', 'kanbini_get_agenda'])
    )
    expect(stderr).toBe('')
  })

  it('reaches the app: a read round-trips to the control channel', async () => {
    const res = (await client.callTool({
      name: 'kanbini_list_boards',
      arguments: {}
    })) as { content: Array<{ text: string }>; isError?: boolean }
    expect(res.isError).toBeFalsy()
    const boards = JSON.parse(res.content[0]!.text) as Array<{ name: string }>
    expect(boards.length).toBeGreaterThan(0)
  })

  it('names only tools the server has, in every skill', async () => {
    const { tools } = await client.listTools()
    const known = new Set(tools.map((t) => t.name))
    for (const dir of skillDirs) {
      const text = readFileSync(skillPath(dir), 'utf8')
      const allowed = frontmatter(skillPath(dir))['allowed-tools'] ?? ''
      for (const m of allowed.matchAll(/mcp__plugin_kanbini_kanbini__(\w+)/g)) {
        expect(known.has(m[1]!), `${dir}: allowed-tools names ${m[1]}`).toBe(true)
      }
      for (const m of text.matchAll(/`(kanbini_\w+)`/g)) {
        expect(known.has(m[1]!), `${dir}: body names ${m[1]}`).toBe(true)
      }
    }
  })

  it('offers the plan_my_day and log_work prompts', async () => {
    const { prompts } = await client.listPrompts()
    expect(prompts.map((p) => p.name)).toEqual(
      expect.arrayContaining(['plan_my_day', 'log_work'])
    )
    const plan = await client.getPrompt({ name: 'plan_my_day' })
    expect(JSON.stringify(plan.messages)).toContain('kanbini_get_agenda')

    const log = await client.getPrompt({
      name: 'log_work',
      arguments: { summary: 'Fixed the login bug', board: 'Work' }
    })
    const text = (log.messages[0]!.content as { text: string }).text
    expect(text).toContain('Fixed the login bug')
    expect(text).toContain('"Work"')
    expect(text).not.toContain('ask me which one')
  })
})

/** Run the launcher on its own and collect how it ended. */
function runLauncher(
  userDataDir: string
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [LAUNCHER], {
      env: { ...process.env, KANBINI_USERDATA_OVERRIDE: userDataDir },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stderr = ''
    let stdout = ''
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.on('exit', (code) => resolvePromise({ code, stderr, stdout }))
  })
}

describe('launcher failures', () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kanbini-plugin-'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('explains that Kanbini must be opened once when there is no pointer', async () => {
    const r = await runLauncher(join(dir, 'never-opened'))
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/Install Kanbini and open it once/)
    // stdout is the MCP channel: nothing may leak onto it.
    expect(r.stdout).toBe('')
  })

  it('rejects a pointer that is not JSON', async () => {
    const d = join(dir, 'bad-json')
    await rm(d, { recursive: true, force: true })
    await import('node:fs/promises').then((f) => f.mkdir(d, { recursive: true }))
    await writeFile(join(d, MCP_SERVER_POINTER_FILE), '{nope')
    const r = await runLauncher(d)
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/isn't valid JSON/)
  })

  it('rejects a pointer with no command', async () => {
    const d = join(dir, 'no-command')
    await import('node:fs/promises').then((f) => f.mkdir(d, { recursive: true }))
    await writeFile(join(d, MCP_SERVER_POINTER_FILE), JSON.stringify({ args: [] }))
    const r = await runLauncher(d)
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/doesn't describe a server/)
  })

  it('says to reopen Kanbini when the recorded app is gone', async () => {
    const d = join(dir, 'moved')
    await import('node:fs/promises').then((f) => f.mkdir(d, { recursive: true }))
    await writeFile(
      join(d, MCP_SERVER_POINTER_FILE),
      JSON.stringify({ command: join(dir, 'Kanbini-was-uninstalled.exe'), args: [] })
    )
    const r = await runLauncher(d)
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/Couldn't start Kanbini's MCP server/)
    expect(r.stderr).toMatch(/open it once/)
  })
})

describe('server lifetime', () => {
  it('exits when the client hangs up, even after talking to the app', async () => {
    const channel = await startFakeChannel()
    try {
      const child = spawn(process.execPath, [SERVER_PATH], {
        env: { ...process.env, KANBINI_USERDATA_OVERRIDE: channel.userDataDir },
        stdio: ['pipe', 'pipe', 'inherit']
      })
      const exited = new Promise<number | null>((r) => child.on('exit', r))
      let buf = ''
      const waitFor = (id: number): Promise<void> =>
        new Promise((r) => {
          const onData = (d: Buffer): void => {
            buf += d.toString()
            if (buf.includes(`"id":${id}`)) {
              child.stdout.off('data', onData)
              r()
            }
          }
          child.stdout.on('data', onData)
        })
      const send = (msg: object): void => {
        child.stdin.write(JSON.stringify(msg) + '\n')
      }

      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'lifetime-test', version: '0' }
        }
      })
      await waitFor(1)
      send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      // A real call opens a keep-alive socket to the control channel.
      send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'kanbini_list_boards', arguments: {} }
      })
      await waitFor(2)

      child.stdin.end()
      const code = await Promise.race([
        exited,
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 5000))
      ])
      if (code === 'timeout') child.kill()
      expect(code).toBe(0)
    } finally {
      await channel.close()
    }
  }, 20_000)
})
