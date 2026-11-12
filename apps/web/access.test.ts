import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { IPC } from '../../packages/shared/src/channels'
import { crossSite, VIEWER_CHANNELS, VIEWER_TOOLS } from './access'

const repo = join(__dirname, '../..')

describe('crossSite', () => {
  const host = 'kanbini.example.com'

  it('lets the app’s own pages through', () => {
    expect(crossSite({ host, 'sec-fetch-site': 'same-origin' })).toBe(false)
    expect(crossSite({ host, origin: `https://${host}` })).toBe(false)
  })

  it('refuses another site, and another port or subdomain of this one', () => {
    expect(crossSite({ host, 'sec-fetch-site': 'cross-site' })).toBe(true)
    // "same-site" covers a sibling subdomain or another port on the NAS,
    // which SameSite=Lax cookies alone would let through.
    expect(crossSite({ host, 'sec-fetch-site': 'same-site' })).toBe(true)
    expect(crossSite({ host, origin: 'https://other.example.com' })).toBe(true)
    expect(crossSite({ host: '10.0.0.5:8080', origin: 'http://10.0.0.5:8081' })).toBe(true)
  })

  it('refuses an opaque or unreadable origin', () => {
    expect(crossSite({ host, origin: 'null' })).toBe(true)
    expect(crossSite({ host, origin: 'not a url' })).toBe(true)
  })

  it('trusts Sec-Fetch-Site over Origin when a browser sends both', () => {
    expect(crossSite({ host, 'sec-fetch-site': 'cross-site', origin: `https://${host}` })).toBe(true)
  })

  it('lets requests through that no browser sent (no cookie can ride on them)', () => {
    expect(crossSite({ host })).toBe(false)
  })
})

describe('what a viewer may call', () => {
  const channels = new Set<string>(Object.values(IPC))

  it('names only channels the app has', () => {
    expect([...VIEWER_CHANNELS].filter((c) => !channels.has(c))).toEqual([])
  })

  it('leaves out every channel that changes boards, files or settings', () => {
    const writes = [
      IPC.mutate, IPC.mutateBatch, IPC.attachmentAdd, IPC.attachmentPasteImage, IPC.linkPreviewCreate,
      IPC.undoApply, IPC.redoApply, IPC.undoClear, IPC.exportNow, IPC.backupsRestore, IPC.importFolder,
      IPC.importTrello, IPC.boardImport, IPC.windowPrefsSet, IPC.obsidianPush, IPC.boardSetBackgroundImage,
      IPC.templateSave, IPC.templateRename, IPC.templateDelete, IPC.templateInstantiate
    ]
    expect(writes.filter((c) => VIEWER_CHANNELS.has(c))).toEqual([])
  })
})

describe('the MCP tools a viewer may use', () => {
  const server = readFileSync(join(repo, 'apps/mcp/src/index.ts'), 'utf8')
  // Every write tool is an op in ops.ts, registered as kanbini_<name>, plus the batch tool.
  const writeTools = [
    'kanbini_batch',
    ...[...readFileSync(join(repo, 'apps/mcp/src/ops.ts'), 'utf8').matchAll(/^\s*name: '(\w+)'/gm)].map((m) => `kanbini_${m[1]}`)
  ]

  it('are tools the MCP server registers', () => {
    expect([...VIEWER_TOOLS].filter((t) => !server.includes(`'${t}'`))).toEqual([])
  })

  it('include no write tool', () => {
    expect(writeTools.length).toBeGreaterThan(20)
    expect(writeTools.filter((t) => VIEWER_TOOLS.has(t))).toEqual([])
  })
})
