// Write-tools smoke (M3-tail). Drives the bundled MCP server as a
// stdio client and runs a full create-update-comment-delete cycle so
// any open desktop renderer should see the card pop in and disappear
// live (broadcastChange + change-event invalidation).
//
// Pre-reqs: desktop app running (with the M3-tail control channel
// code - restart the app after pulling the M3-tail commit) and a
// fresh MCP bundle (`pnpm --filter @kanbini/mcp run build`).

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
const client = new Client({ name: 'kanbini-smoke-write', version: '0.0.0' })
await client.connect(transport)

function unwrap(res, label) {
  const text = res.content?.[0]?.text ?? '(no text)'
  if (res.isError) {
    throw new Error(`${label} failed: ${text}`)
  }
  return JSON.parse(text)
}

// 1. List tools - verify write tools are present.
const tools = (await client.listTools()).tools.map((t) => t.name)
const expected = [
  'kanbini_create_card',
  'kanbini_update_card',
  'kanbini_move_card',
  'kanbini_delete_card',
  'kanbini_set_card_labels',
  'kanbini_post_comment',
  'kanbini_create_checklist',
  'kanbini_add_checklist_item',
  'kanbini_toggle_checklist_item'
]
const missing = expected.filter((t) => !tools.includes(t))
if (missing.length > 0) {
  console.error('missing tools:', missing.join(', '))
  process.exit(1)
}
console.log(`tools: ${tools.length} registered (read + write)`)

// 2. Get the board, pick a target list.
const board = unwrap(
  await client.callTool({ name: 'kanbini_get_board', arguments: {} }),
  'get_board'
)
const openLists = board.lists.filter((l) => !l.closed)
const target = openLists[0]
if (!target) throw new Error('no open list to write to')
console.log(`target list: "${target.name}" (${target.cards.length} cards)`)

// 3. Create a card.
const created = unwrap(
  await client.callTool({
    name: 'kanbini_create_card',
    arguments: { listId: target.id, title: '🤖 Hello from MCP write tools!' }
  }),
  'create_card'
)
console.log(`✓ created card ${created.id}`)

// Anything from here on creates state that should be cleaned up even
// if a later step throws - wrap the rest so we always try to delete.
let exitCode = 0
try {
  // 4. Update its description + due date.
  const dueAt = Date.now() + 7 * 24 * 60 * 60 * 1000 // 7 days out
  unwrap(
    await client.callTool({
      name: 'kanbini_update_card',
      arguments: {
        id: created.id,
        patch: {
          description:
            'Written by the **MCP write tools smoke script**.\n\nIf you see this card in the open Kanbini window, the live-update path works.',
          dueAt
        }
      }
    }),
    'update_card'
  )
  console.log('✓ updated description + due date')

  // 5. Post an AI comment.
  unwrap(
    await client.callTool({
      name: 'kanbini_post_comment',
      arguments: {
        cardId: created.id,
        body: 'This comment was posted by the AI MCP tool - note the AI badge.'
      }
    }),
    'post_comment'
  )
  console.log('✓ posted ai-authored comment')

  // 6. Add a checklist with two items, toggle one done.
  const cl = unwrap(
    await client.callTool({
      name: 'kanbini_create_checklist',
      arguments: { cardId: created.id, name: 'Smoke steps' }
    }),
    'create_checklist'
  )
  const item1 = unwrap(
    await client.callTool({
      name: 'kanbini_add_checklist_item',
      arguments: { checklistId: cl.id, text: 'Card created via MCP' }
    }),
    'add_item_1'
  )
  unwrap(
    await client.callTool({
      name: 'kanbini_add_checklist_item',
      arguments: { checklistId: cl.id, text: 'Renderer reflected it live' }
    }),
    'add_item_2'
  )
  unwrap(
    await client.callTool({
      name: 'kanbini_toggle_checklist_item',
      arguments: { id: item1.id, completed: true }
    }),
    'toggle_item'
  )
  console.log('✓ added checklist with 2 items, one checked')

  // 7. Verify by reading the card back.
  const detail = unwrap(
    await client.callTool({
      name: 'kanbini_get_card',
      arguments: { id: created.id }
    }),
    'get_card'
  )
  console.log(
    `read back: "${detail.title}" - checklists:${detail.checklists.length}, comments:${detail.comments.length}, activities:${detail.activities.length}`
  )

  // 8. Pause so a watching user can see the card appear before delete.
  console.log('… leaving card on board for 10 s so you can see it live …')
  await new Promise((r) => setTimeout(r, 10_000))
} catch (err) {
  console.error('!! step failed:', err instanceof Error ? err.message : err)
  exitCode = 1
} finally {
  // 9. Always try to clean up the test card so we don't litter.
  try {
    unwrap(
      await client.callTool({
        name: 'kanbini_delete_card',
        arguments: { id: created.id }
      }),
      'delete_card'
    )
    console.log('✓ deleted test card (cleanup)')
  } catch (err) {
    console.error(
      '!! cleanup failed - please delete the test card manually:',
      err instanceof Error ? err.message : err
    )
    exitCode ||= 1
  }
}

await client.close()
console.log(exitCode === 0 ? '\ndone - write tools end-to-end ✓' : '\ndone with errors')
process.exit(exitCode)
