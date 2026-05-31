// Smoke-test the bundled MCP server end-to-end. Spawns
// `node dist/index.js` and drives it as a real MCP stdio client - so
// it exercises the SDK framing, the tool registry, the userData
// lookup, and the HTTP control channel in the desktop app.
//
// Usage: `pnpm --filter @kanbini/mcp run smoke` (or `node
// scripts/smoke.mjs`). With the desktop app running it should print
// the tool list and a JSON board view; with it stopped you'll see
// the AppOfflineError surfaced as the tool's text error.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const serverPath = join(here, '..', 'dist', 'index.js')

if (!existsSync(serverPath)) {
  console.error(
    `! ${serverPath} not found - run \`pnpm --filter @kanbini/mcp run build\` first.`
  )
  process.exit(1)
}

const transport = new StdioClientTransport({
  command: process.execPath, // current node binary
  args: [serverPath]
})

const client = new Client({ name: 'kanbini-smoke', version: '0.0.0' })
await client.connect(transport)
console.log('connected')

const tools = await client.listTools()
console.log(
  'tools:',
  tools.tools.map((t) => t.name).join(', ')
)

// M4-G: enumerate boards before drilling into one. Verifies the new
// kanbini_list_boards tool round-trips through the control channel.
const boardsList = await client.callTool({
  name: 'kanbini_list_boards',
  arguments: {}
})
const boardsText = boardsList.content?.[0]?.text ?? '(no text)'
if (boardsList.isError) {
  console.log('kanbini_list_boards → error:', boardsText)
} else {
  const summaries = JSON.parse(boardsText)
  console.log(`kanbini_list_boards → ${summaries.length} board(s)`)
}

const board = await client.callTool({
  name: 'kanbini_get_board',
  arguments: {}
})
const text = board.content?.[0]?.text ?? '(no text)'
if (board.isError) {
  console.log('kanbini_get_board → error:', text)
} else {
  const parsed = JSON.parse(text)
  if (parsed === null) {
    console.log('kanbini_get_board → null (no board)')
  } else {
    console.log(
      `kanbini_get_board → board "${parsed.board.name}", ${parsed.lists.length} lists`
    )
    const firstCard = parsed.lists[0]?.cards?.[0]
    if (firstCard) {
      const card = await client.callTool({
        name: 'kanbini_get_card',
        arguments: { id: firstCard.id }
      })
      const ct = card.content?.[0]?.text ?? '(no text)'
      if (card.isError) {
        console.log('kanbini_get_card → error:', ct)
      } else {
        const cp = JSON.parse(ct)
        console.log(
          `kanbini_get_card → "${cp.title}", ${cp.activities.length} activity rows`
        )
      }
    }
  }
}

await client.close()
console.log('done')
