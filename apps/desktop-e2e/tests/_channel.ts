import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

// Test-side client for the app's MCP control channel. Specs use it to
// SET UP data (a card with checklists and comments) far faster than
// clicking through the UI, and to read back what the DB stored - the UI
// assertions stay in the spec. Launch with a known `userDataDir` so the
// discovery file can be found.

export interface Discovery {
  port: number
  token: string
  pid: number
}

/** Wait for `<userData>/mcp.json`; main writes it inside whenReady, so
 *  it can trail the first window. */
export async function waitForDiscovery(
  userDataDir: string,
  timeoutMs = 5000
): Promise<Discovery> {
  const start = Date.now()
  const path = join(userDataDir, 'mcp.json')
  while (Date.now() - start < timeoutMs) {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as Discovery
    } catch {
      await sleep(100)
    }
  }
  throw new Error(`mcp.json did not appear at ${path} within ${timeoutMs} ms`)
}

/** One JSON-RPC call; throws with the channel's error on a non-200. */
export async function rpc<T = unknown>(
  d: Discovery,
  method: string,
  params: unknown
): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${d.port}/rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${d.token}`
    },
    body: JSON.stringify({ method, params })
  })
  const body = (await res.json()) as T & { error?: string }
  if (res.status !== 200) {
    throw new Error(`${method} -> HTTP ${res.status}: ${body.error ?? ''}`)
  }
  return body
}

/** Shorthand for a `mutate` call; returns the new/affected id. */
export async function mutate(d: Discovery, m: Record<string, unknown>): Promise<string> {
  return (await rpc<{ id: string }>(d, 'mutate', m)).id
}
