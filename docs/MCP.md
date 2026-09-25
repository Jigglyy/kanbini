# Kanbini · MCP integration

This is how Claude (Desktop, Code, or any MCP client) reads **and
mutates** the running Kanbini app's boards: read tools, a full write
surface, and multi-board discovery + creation. Every AI edit flows
through main, fires `broadcastChange`, and shows up live in the open
renderer.

---

## Architecture

```
  Claude Desktop / Code (or any MCP client)
       │
       │ stdio (MCP protocol)
       ▼
  @kanbini/mcp                ─ reads <userData>/mcp.json for { port, token }
  (bundled Node ESM file)
       │
       │ HTTP POST 127.0.0.1:<port>/rpc
       │ Authorization: Bearer <token>
       │ { "method": "...", "params": {...} }
       ▼
  Electron main · control channel server
       │
       ▼
  getBoardView / getCardView / mutate (reads + writes)
```

- **Stdio transport** because that's what Claude Desktop / Code
  launch directly - one process per MCP server, no port management
  on the client side.
- **127.0.0.1 control channel** because main owns the live SQLite
  connection (DESIGN §5 single-writer). The MCP process never opens
  the DB itself, so there's exactly one source of truth.
- **Bearer token** from a 32-byte hex file in `userData`, persisted
  at mode `0o600`. Without it, any local process could write to the
  board.
- **Discovery via `mcp.json`** - the running app publishes
  `{ port, token, pid }` on start and removes the file on quit, so
  the MCP server can detect "app offline" cleanly (and surface it
  as a structured tool error instead of hanging).

---

## Build the MCP server

The MCP server is a separate Node process. Bundle it once:

```sh
pnpm install
pnpm --filter @kanbini/mcp run build
```

That produces `apps/mcp/dist/index.js` - a single ESM file with a
shebang, runnable as `node apps/mcp/dist/index.js`. Node 18 or newer
required (built-in `fetch`).

---

## Using the installed app (no repo, no Node.js)

Everything below assumes a repo checkout. If you installed Kanbini from
the installer instead, you don't need any of it - the app ships the
server bundle and the runtime that executes it.

Open **Settings -> AI integration** and copy the snippet. It looks like
this, with your own install path filled in:

```json
{
  "mcpServers": {
    "kanbini": {
      "command": "C:\\Users\\<you>\\AppData\\Local\\Programs\\Kanbini\\Kanbini.exe",
      "args": ["C:\\Users\\<you>\\AppData\\Local\\Programs\\Kanbini\\resources\\mcp\\index.js"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

`ELECTRON_RUN_AS_NODE=1` tells Electron to behave as a plain Node
runtime and run the script instead of opening a window. That is how the
installed app avoids requiring a separate Node.js install - it already
contains one. Without the env var Electron boots a second copy of the
UI and the client waits forever for a handshake.

Known limit: the **portable** `.exe` unpacks itself to a fresh temp
directory on every launch, so both paths in its snippet go stale the
next time you run it. Use the installer if you want a config you can
paste once.

---

## Configure Claude Desktop

Edit your Claude Desktop config file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Add a `kanbini` entry under `mcpServers`. Use the absolute path to
the bundled file. (This is the repo-checkout form, which runs on the
`node` you already have; for an installed Kanbini use the snippet from
Settings -> AI integration instead.)

```json
{
  "mcpServers": {
    "kanbini": {
      "command": "node",
      "args": ["C:\\Users\\<you>\\Kanbini\\apps\\mcp\\dist\\index.js"]
    }
  }
}
```

(On macOS / Linux the path is `/Users/<you>/Kanbini/apps/mcp/dist/index.js`.)

Quit Claude Desktop fully and reopen. The Kanbini tools
(`kanbini_list_boards`, `kanbini_get_board`, `kanbini_get_card`, plus
the write tools) should now appear in the tool picker.

---

## Configure Claude Code

In any project's repo, add a `.mcp.json`:

```json
{
  "mcpServers": {
    "kanbini": {
      "command": "node",
      "args": ["/absolute/path/to/Kanbini/apps/mcp/dist/index.js"]
    }
  }
}
```

Or run with a CLI flag in a one-off session - see the Claude Code
docs for the exact flag your version supports.

---

## Verify end-to-end

With the Kanbini app running, drive the bundled MCP server as a
stdio client and call both tools:

```sh
pnpm --filter @kanbini/mcp run smoke
```

Expected output (tool list truncated for brevity):

```
connected
tools: kanbini_list_boards, kanbini_get_board, kanbini_get_card, …
kanbini_list_boards → 1 board(s)
kanbini_get_board → board "Welcome Board", 3 lists
kanbini_get_card → "Drag a card to another list", 0 activity rows
done
```

If the desktop app isn't running, **read tools fall back to the
last on-disk export**. The response is prefixed with a
one-line `[NOTE]` so the AI knows it's reading a snapshot:

```
[NOTE] Kanbini desktop app is closed. Reading from the last on-disk
export (snapshot from 2026-05-25T14:32:01.000Z). Writes need the
app open.

{ "lists": [ ... ] }
```

If no export exists yet (the app has never run), reads error too
with a message pointing the user at how to fix it. Writes always
error when the app is closed - surface a clear "open the app" hint
to the user.

---

## Tools

### Read

#### `kanbini_list_boards`

Enumerate every board in the database. Call this first to discover
`boardId`s before `kanbini_get_board`.

(No arguments.)

Returns an array of summaries:

| Field          | Type      | Notes                                                    |
|----------------|-----------|----------------------------------------------------------|
| `id`           | `string`  | UUIDv7.                                                  |
| `projectId`    | `string`  | Internal; the UI hides projects.              |
| `name`         | `string`  |                                                          |
| `description`  | `string \| null` |                                                   |
| `archived`     | `boolean` | Archived boards are returned too; filter client-side.    |
| `position`     | `string`  | Fractional-index, ascending.                             |
| `listCount`    | `number`  | Non-closed lists.                                        |
| `cardCount`    | `number`  | Non-archived cards across all lists on the board.        |
| `createdAt`    | `number`  | Epoch ms.                                                |
| `updatedAt`    | `number`  | `MAX(board.updatedAt, latest activity-log entry)` - sort by this for "recently used". |

Returns `[]` if no boards exist yet.

#### `kanbini_get_board`

Returns one board with all its lists, cards, labels, and each card's
checklists / comments / attachments / activity feed (same shape the
renderer consumes).

| Argument  | Type     | Required | Notes                                                      |
|-----------|----------|----------|------------------------------------------------------------|
| `boardId` | `string` | no       | Defaults to the first board. Use `kanbini_list_boards` for multi-board DBs. |

Archived cards are left out. Archived lists are included with
`closed: true` (the app hides them). Returns `null` if the id doesn't
match anything.

#### `kanbini_get_card`

Returns one card by id with the same depth as a card inside the
board view.

| Argument | Type     | Required | Notes                       |
|----------|----------|----------|-----------------------------|
| `id`     | `string` | yes      | UUIDv7 from `get_board`.    |

Works for archived cards too. Returns `null` if the id doesn't exist.

#### `kanbini_list_archived`

What a board has put away. Archived cards and lists don't show on the
board, in search, or in the home counts, and **the app has no screen
for them yet**, so this is how to find them again.

| Argument  | Type     | Required |
|-----------|----------|----------|
| `boardId` | `string` | yes      |

Returns `{ boardId, lists, cards }`:

- `lists`: archived lists by board position, each
  `{ id, name, color, cardCount }` (`cardCount` = live cards inside,
  which come back with the list).
- `cards`: archived cards, most recently touched first, each
  `{ id, title, listId, listName, listClosed, updatedAt }`. When
  `listClosed` is true the card is in an archived list, so restoring
  the card alone won't make it visible.

Returns `null` for an unknown board. Falls back to the on-disk export
when the app is closed, like the other reads.

### Write

All write tools return `{ id, boardId }` (the affected entity + its
board, for scoped refetch). Every successful write fires
`broadcastChange(boardId)` on the desktop side, so the open
renderer reflects the edit live.

#### `kanbini_create_board`
Create a new empty board (no lists, no cards). Auto-assigned to
Kanbini's default project (projects are hidden in the UI).
`id` and `boardId` in the result both equal the new board's id.

| Argument      | Type     | Required | Notes                                       |
|---------------|----------|----------|---------------------------------------------|
| `name`        | `string` | yes      | Min length 1.                               |
| `description` | `string` | no       | Optional short blurb shown on the home grid.|

#### `kanbini_create_list`
Append a list (column) to the right end of a board. Use the returned
`id` as the `listId` for `kanbini_create_card`.

| Argument  | Type     | Required | Notes         |
|-----------|----------|----------|---------------|
| `boardId` | `string` | yes      |               |
| `name`    | `string` | yes      | Min length 1. |

#### `kanbini_create_card`
Append a card to the end of a list.

| Argument   | Type     | Required | Notes                                                                       |
|------------|----------|----------|-----------------------------------------------------------------------------|
| `listId`   | `string` | yes      |                                                                             |
| `title`    | `string` | yes      | Min length 1.                                                               |
| `priority` | `string` | no       | One of `low` / `medium` / `high` / `urgent`; omit for unprioritised.        |

#### `kanbini_update_card`
Patch one or more card fields. Omit fields you don't want to change.

| Patch field           | Type             | Notes                              |
|-----------------------|------------------|------------------------------------|
| `title`               | `string`         | Min length 1.                      |
| `description`         | `string \| null` | Markdown. `null` clears.           |
| `dueAt`               | `number \| null` | Epoch ms. `null` clears.           |
| `completed`           | `boolean`        | Toggles the checkbox.              |
| `coverAttachmentId`   | `string \| null` | Set or clear the cover banner.     |

#### `kanbini_move_card`
Move a card between lists, or reorder within its list.

| Argument    | Type             | Notes                                              |
|-------------|------------------|----------------------------------------------------|
| `id`        | `string`         | Card to move.                                      |
| `toListId`  | `string`         | Destination list.                                  |
| `beforeId`  | `string \| null` | Card that should sit immediately ABOVE the moved card. |
| `afterId`   | `string \| null` | Card that should sit immediately BELOW.            |

Pass both `null` to append to the end. Server mints the fractional-
index position between the two neighbours - concurrent moves never
collide.

#### `kanbini_delete_card`
Permanently delete a card. Checklists, comments, and attachment rows
cascade. The attachment files are left on disk and removed by the app's
startup cleanup sweep once they're more than an hour old.

| Argument | Type     | Required |
|----------|----------|----------|
| `id`     | `string` | yes      |

#### `kanbini_set_card_labels`
Replace the full label set on a card (idempotent).

| Argument    | Type       | Notes                                |
|-------------|------------|--------------------------------------|
| `id`        | `string`   | Card id.                             |
| `labelIds`  | `string[]` | Pass `[]` to remove all labels.      |

Every id must be a label on the **card's own board**. An unknown id or
one from another board is rejected and nothing changes. Make a missing
label with `kanbini_create_label`.

#### `kanbini_post_comment`
Post a comment **as the AI** - author is forced to `'ai'`, so the
UI renders it with the AI badge.

| Argument | Type     | Required |
|----------|----------|----------|
| `cardId` | `string` | yes      |
| `body`   | `string` | yes      |

Body is Markdown.

#### `kanbini_create_checklist`
Add a new checklist to a card. Use the returned id with
`kanbini_add_checklist_item` to populate it.

| Argument | Type     | Required |
|----------|----------|----------|
| `cardId` | `string` | yes      |
| `name`   | `string` | yes      |

#### `kanbini_add_checklist_item`
Append one item to an existing checklist.

| Argument       | Type     | Required |
|----------------|----------|----------|
| `checklistId`  | `string` | yes      |
| `text`         | `string` | yes      |

#### `kanbini_toggle_checklist_item`
Mark a checklist item complete (`true`) or reopen it (`false`).

| Argument    | Type      | Required |
|-------------|-----------|----------|
| `id`        | `string`  | yes      |
| `completed` | `boolean` | yes      |

#### `kanbini_archive_card`
Archive (`archived: true`) or restore (`archived: false`) a card. An
archived card leaves the board, search, and counts but keeps its list,
position, and everything attached, so restoring puts it back where it
was. Logged in the card's activity feed and undoable with Ctrl+Z.

| Argument   | Type      | Required |
|------------|-----------|----------|
| `id`       | `string`  | yes      |
| `archived` | `boolean` | yes      |

### Colours

Every tool that takes a colour accepts either a **palette name** -
`red`, `orange`, `amber`, `yellow`, `lime`, `green`, `teal`, `cyan`,
`sky`, `blue`, `indigo`, `purple`, `pink`, `rose` (case-insensitive) -
or a raw CSS colour string (32 characters max). Names resolve to the
exact swatch the app's colour pickers offer, so prefer them; a raw
colour still works, and the picker shows it as an extra swatch.

### Boards and lists

#### `kanbini_update_board`
Patch a board. Omit fields you don't want to change.

| Field         | Type                 | Notes                                        |
|---------------|----------------------|----------------------------------------------|
| `id`          | `string`             | Board id.                                    |
| `patch.name`        | `string`       | Rename.                                      |
| `patch.description` | `string \| null` | Home-picker blurb; `null` clears it.       |
| `patch.color`       | colour `\| null` | Accent on the home card + header; `null` clears it. |
| `patch.pinned`      | `boolean`      | Favourite to the top of the home picker.     |

#### `kanbini_archive_board`
Archive or restore a board (`id`, `archived`). An archived board is
hidden from the home picker (still reachable with "Show archived") and
its cards drop out of search. Nothing is deleted.

#### `kanbini_update_list`
Patch a list. Omit fields you don't want to change.

| Field            | Type                  | Notes |
|------------------|-----------------------|-------|
| `id`             | `string`              | List id. |
| `patch.name`     | `string`              | Rename. |
| `patch.color`    | colour `\| null`      | Header band + border; `null` clears it. |
| `patch.wipLimit` | positive int `\| null` | Work-in-progress cap; `null` removes it. The app blocks drags past it, but writes are NOT capped - check the card count before adding. |
| `patch.sortMode` | see below             | How the list orders its cards. |
| `patch.onEnter`  | `"complete" \| "uncomplete" \| null` | Runs when a card is moved in from another list. `null` removes the rule. |

`sortMode` values: `manual` (drag order, the default), `created-asc` /
`created-desc`, `added-asc` / `added-desc` (when the card entered this
list), `due-asc` (soonest first, undated last), `title-asc` /
`title-desc`, `priority-desc` (urgent first). Switching back to
`manual` keeps the sorted order that was on screen as the new drag
order.

#### `kanbini_move_list`
Reorder a list on its board.

| Argument   | Type             | Notes |
|------------|------------------|-------|
| `id`       | `string`         | The list to move. |
| `beforeId` | `string \| null` | List that should sit immediately to its **left**; omit for far left. |
| `afterId`  | `string \| null` | List immediately to its **right**; omit for far right. |

#### `kanbini_archive_list`
Archive or restore a whole list with its cards (`id`, `archived`).
Nothing is deleted, and restoring brings it back in its original slot.
Find archived lists with `kanbini_list_archived`.

### Labels

Labels belong to one board.

#### `kanbini_create_label`
`boardId`, `name`, `color` (required). Returns `{ id, boardId }`; put it
on cards with `kanbini_set_card_labels`. Check the board's existing
`labels[]` first to avoid near-duplicates.

#### `kanbini_update_label`
`id` plus a `patch` of `name` and/or `color`. The change shows on
every card with the label.

#### `kanbini_delete_label`
`id`. Removes the label from its board and from every card that has
it. Ctrl+Z in the app restores it on the same cards.

### Attachments

#### `kanbini_add_attachment`
Attach a file to a card from **one** of two sources:

| Argument   | Type                 | Notes |
|------------|----------------------|-------|
| `cardId`   | `string`             | Required. |
| `path`     | `string`             | Absolute path to a local file; the app copies it in. Up to 100 MB. |
| `filename` | `string`             | With `content`: the name to store it under. Its extension sets the file type. |
| `content`  | `string`             | Inline data. |
| `encoding` | `"utf8" \| "base64"` | For `content`. Default `utf8` (text); `base64` for small binaries, up to 10 MB decoded. |

Relative paths are rejected (the app resolves the path in its own
process, where a relative path means something else). Inline filenames
are made safe as one path segment before touching disk, so a name like
`../../x` can't escape the attachment folder.

Returns the stored attachment (`id`, `filename`, `relPath`, `mime`,
`size`, ...) plus `boardId`. To make an image the card's cover, pass its
`id` as `coverAttachmentId` to `kanbini_update_card`.

#### `kanbini_delete_attachment`
`id`. Deletes the attachment **and its file**, and clears the card's
cover if it pointed there. Ctrl+Z in the app restores the entry but not
the file.

---

## Direct HTTP API (without MCP)

The same 127.0.0.1 control channel the MCP server speaks to is also a
documented local HTTP API, for consumers that don't talk MCP: your own
scripts, automation, a future mobile companion, etc. It's the *same*
dispatch table behind the MCP tools - no second server, no second
implementation.

Same rules as the MCP hop apply:

- **Loopback only** (`127.0.0.1`) and **bearer-token authenticated** on
  every request. Read `port` + `token` from `<userData>/mcp.json` (see
  Troubleshooting for where userData lives).
- **App must be running.** Unlike the MCP read tools (which fall back to
  the on-disk export when the app is closed, see Architecture), the HTTP
  API needs the live DB - reads and writes both require the app open.
- Writes land on the **same global undo stack** as everything else, so a
  user can Ctrl+Z an API-driven change.

### Endpoints

| Method + path            | Maps to        | Body / query                          |
|--------------------------|----------------|---------------------------------------|
| `GET  /boards`           | `boards.list`  | -                                     |
| `GET  /boards/:id`       | `board.getView`| -                                     |
| `GET  /boards/:id/archived` | `board.archived` | -                                |
| `GET  /cards/:id`        | `card.get`     | -                                     |
| `GET  /search?query=&limit=` | `search.cards` | query string                      |
| `POST /mutate`           | `mutate`       | one mutation (the `zMutation` union)  |
| `POST /mutate/batch`     | `mutate.batch` | `zMutation[]` or `{ "mutations": [] }`|
| `POST /attachments`      | `attachment.add` | `{ cardId, path }` or `{ cardId, filename, content, encoding? }` |
| `POST /rpc`              | any method     | `{ "method": "...", "params": {} }`   |

`POST /rpc` is the original JSON-RPC envelope (what the bundled MCP
server uses); the REST routes are ergonomic aliases over the identical
methods. A mutation's shape is the discriminated union documented under
**Tools → Write** above (e.g. `{ "type": "card.create", "listId": "...",
"title": "..." }`).

`/mutate/batch` applies every mutation in **one transaction** recorded
as a **single undo group** - one round trip, atomic, and one Ctrl+Z
reverses the whole gesture. It rejects `restore` and `attachment.delete`
(the latter removes a file as well as a row, which is done per call).
A single `attachment.delete` through `POST /mutate` (or the
`attachment.delete` RPC method) deletes the file too.

Request bodies are capped at 16 MB, which leaves room for a 10 MB inline
attachment encoded as base64.

### Example

```sh
# discover (jq optional)
PORT=$(jq -r .port  "$APPDATA/Kanbini/mcp.json")   # Windows path shown
TOK=$(jq -r .token "$APPDATA/Kanbini/mcp.json")
H="Authorization: Bearer $TOK"

# read
curl -s -H "$H" "http://127.0.0.1:$PORT/boards"
curl -s -H "$H" "http://127.0.0.1:$PORT/search?query=design&limit=10"

# write one card
curl -s -H "$H" -H 'Content-Type: application/json' \
  -d '{"type":"card.create","listId":"<id>","title":"From a script"}' \
  "http://127.0.0.1:$PORT/mutate"

# write several atomically (one undo group)
curl -s -H "$H" -H 'Content-Type: application/json' \
  -d '[{"type":"card.create","listId":"<id>","title":"A"},
       {"type":"card.create","listId":"<id>","title":"B"}]' \
  "http://127.0.0.1:$PORT/mutate/batch"
```

Errors are JSON `{ "error": "..." }` with `400` (validation / unknown
method / bad body), `401` (missing or wrong token), `404` (no such
route), or `500` (unexpected). The view + mutation **schemas are a
stability contract** once you build on them - they're shared from
`@kanbini/shared`.

---

## Troubleshooting

### "Kanbini app is not running"
The MCP server couldn't find `<userData>/mcp.json` or the port was
unreachable, **and** no on-disk export exists yet - so the headless
fallback had nothing to read either. Start the desktop
app once to create the first export; thereafter reads work even
when it's closed. Where userData lives:

- Windows: `%APPDATA%\Kanbini`
- macOS: `~/Library/Application Support/Kanbini`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/Kanbini`

### Tools don't appear in Claude Desktop
- Did you fully **quit** Claude Desktop (not just close the window)
  before reopening? Configuration loads on launch.
- Check the path in `claude_desktop_config.json` resolves to the
  bundled file. Run it directly - `node /path/to/dist/index.js` -
  and you should see no output and no exit (the server waits on
  stdin).
- Tail Claude Desktop's MCP logs:
  - macOS: `~/Library/Logs/Claude/mcp*.log`
  - Windows: `%APPDATA%\Claude\logs\mcp*.log`

### "control channel: HTTP 401"
The bearer token in `mcp.json` doesn't match `mcp-token`. This
shouldn't normally happen - both files live in the same userData
directory. If they're out of sync, delete both and relaunch the
app; main will regenerate them.

### Connection refused
The app's listener has shut down (e.g. the process crashed) but
`mcp.json` wasn't cleaned up. The MCP server treats this the same
as "app offline". Restart the desktop app.

---

## What's next

- **MCP resource subscriptions**: today Claude has to re-read the
  board to see human-side changes. The SDK supports server-push
  via resources; main already broadcasts `changed`, so wiring it
  into the control channel as a long-poll or SSE stream is a
  natural follow-up. Nice-to-have, not blocking.
- **An in-app view of archived cards and lists**: the archive tools
  and `kanbini_list_archived` make archiving reversible from the AI
  side, but the app itself has no screen to browse or restore them
  yet.
