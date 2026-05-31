// Richer one-off demo: drives the bundled MCP server as a real stdio
// client, walks the live board, and dumps a sample card with its full
// payload so you can see exactly what the AI sees through each tool.
//
// Usage: pnpm --filter @kanbini/mcp run explore (with the app running).

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const serverPath = join(here, '..', 'dist', 'index.js')

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath]
})
const client = new Client({ name: 'kanbini-explore', version: '0.0.0' })
await client.connect(transport)

const tools = await client.listTools()
console.log('── tools ────────────────────────────────────────────')
for (const t of tools.tools) {
  console.log(`  ${t.name}`)
  console.log(`    ${t.description.split('\n')[0]}`)
}

console.log('\n── kanbini_get_board ────────────────────────────────')
const boardRes = await client.callTool({
  name: 'kanbini_get_board',
  arguments: {}
})
const board = JSON.parse(boardRes.content[0].text)
console.log(`  project: ${board.project.name}`)
console.log(`  board:   ${board.board.name}`)
console.log(`  labels:  ${board.labels.length}`)
for (const list of board.lists) {
  console.log(`  list "${list.name}" (${list.cards.length} cards)`)
  for (const c of list.cards.slice(0, 3)) {
    const flags = [
      c.completed ? '✓' : ' ',
      c.coverAttachmentId ? '🖼' : ' ',
      c.attachments.length > 0 ? `📎${c.attachments.length}` : '',
      c.checklists.length > 0 ? `☐${c.checklists.length}` : '',
      c.comments.length > 0 ? `💬${c.comments.length}` : '',
      c.activities.length > 0 ? `⚡${c.activities.length}` : ''
    ].filter(Boolean).join(' ')
    console.log(`    ${flags}  ${c.title}`)
  }
  if (list.cards.length > 3) console.log(`    … +${list.cards.length - 3} more`)
}

// Find the most "interesting" card (max activity rows) to show the
// detail tool with real data.
const allCards = board.lists.flatMap((l) => l.cards)
const sample = allCards
  .slice()
  .sort((a, b) => b.activities.length - a.activities.length)[0]

if (sample) {
  console.log(
    `\n── kanbini_get_card { id: "${sample.id}" } ──────────────────`
  )
  const cardRes = await client.callTool({
    name: 'kanbini_get_card',
    arguments: { id: sample.id }
  })
  const card = JSON.parse(cardRes.content[0].text)
  console.log(`  title:       ${card.title}`)
  console.log(
    `  description: ${card.description ? card.description.slice(0, 120).replace(/\n/g, ' ') + (card.description.length > 120 ? '…' : '') : '(none)'}`
  )
  console.log(`  completed:   ${card.completed}`)
  console.log(`  labels:      ${card.labelIds.length}`)
  console.log(`  checklists:  ${card.checklists.length}`)
  console.log(`  comments:    ${card.comments.length}`)
  console.log(`  attachments: ${card.attachments.length}`)
  console.log(`  activities:  ${card.activities.length}`)
  if (card.activities.length > 0) {
    console.log('  recent activity:')
    for (const a of card.activities.slice(0, 5)) {
      const when = new Date(a.createdAt).toISOString()
      const d = a.data ? ` ${JSON.stringify(a.data)}` : ''
      console.log(`    ${when}  ${a.type}${d}`)
    }
  }
}

console.log('\n── error path: kanbini_get_card { id: "no-such-id" } ──')
const bad = await client.callTool({
  name: 'kanbini_get_card',
  arguments: { id: 'no-such-id' }
})
const badText = bad.content[0].text
console.log(`  isError: ${bad.isError ?? false}, body: ${badText}`)

await client.close()
console.log('\ndone')
