# Kanbini - Design & Architecture

Offline, single-user, free and open-source (MIT) desktop kanban app with a
local MCP server. Clean-room (no Planka/Trello code or assets). Windows is
the primary target; macOS and Linux build from the same Electron codebase.

---

## 1. Goals / non-goals

**Goals**
- Trello/Planka-class kanban: boards -> lists -> cards, with labels, due
  dates, priorities, checklists, comments, and local attachments + cover
  images.
- 100% offline. No accounts, auth, network, telemetry, or cloud.
- A local **MCP server** so an AI can read and modify the board; edits
  stream into the open UI live.
- First-class **plain-text export/import** (Markdown + JSON) - data
  ownership is a product value, not a footnote.
- One codebase across desktop OSes.

**Non-goals**
- Multi-user / real-time collaboration / sharing / accounts / SSO /
  email / webhooks / cloud sync. (Cloud sync could come later for a
  mobile companion; not in scope now.)

---

## 2. Licensing / IP

- License: **MIT** - free and open source.
- **Clean-room only.** No source, assets, names, or logos from Planka
  (restrictive "Fair Use License"), Trello, or others. Concepts and UX
  patterns may inspire; all code is written fresh.
- **Permissive dependencies only** (MIT/Apache/BSD or similar). No
  GPL/AGPL/source-available code in the shipped artifact.

---

## 3. Persistence - SQLite with plain-text export

**Source of truth: SQLite** (`better-sqlite3` + Drizzle), a single file in
Electron `userData`, WAL mode, single writer (the main process).
Transactional, fast to search and reorder, trivial to back up (copy one
file), and strongly typed through the ORM.

**Plain-text layer (core, not optional):**
- **Export:** a deterministic dump of the whole workspace - `kanbini.json`
  (all tables) + `cards/<id>.md` (description bodies) + attachment file
  copies. Human-readable, diff-able, git-able.
- **Import:** reads that tree back into SQLite, losslessly (verified
  byte-for-byte by `pnpm --filter @kanbini/desktop run test:roundtrip`).
- SQLite stays authoritative at runtime; export runs on demand and
  automatically on quit.

Attachments live under `userData/attachments/<id>/`, referenced by id and
served to the renderer through the `kanbini-file://` scheme; they are
copied into the export tree.

---

## 4. Shell - Electron

Electron gives a single-language TS stack (renderer + main + MCP), trivial
`better-sqlite3` integration, consistent Chromium rendering, and mature
packaging. It is pinned to the newest release with a working prebuilt
`better-sqlite3` (currently 41); re-probe before any bump.

Hardening: `contextIsolation: true`, `nodeIntegration: false`, sandbox
where possible, a strict typed preload bridge (minimal surface), a strict
CSP, and no remote content.

---

## 5. Architecture

```
+---------------------------- Electron ----------------------------+
| MAIN (Node/TS) - single SQLite writer                            |
|  - better-sqlite3 + Drizzle (WAL)                                |
|  - domain/service layer (zod-validated)                          |
|  - ipcMain.handle(...) typed handlers for the renderer           |
|  - control channel (127.0.0.1 + bearer token) for MCP            |
|  - change-event bus -> renderer (live updates)                   |
|  - plain-text export/import                                      |
|                                                                  |
| PRELOAD - minimal typed bridge (contextBridge)                   |
|                                                                  |
| RENDERER (React + Vite + ShadCN) - kanban UI                     |
|  - calls main via typed IPC; subscribes to change events         |
+------------------------------------------------------------------+
            ^ control channel (loopback only, token-gated)
+-----------+--------- MCP server (separate Node/TS, stdio) -------+
| @modelcontextprotocol/sdk, spawned by the AI client. Tools ->    |
| app control channel -> service layer -> SQLite -> live UI event. |
| When the app is closed, the read tools fall back to the plain-   |
| text export tree; writes return a clear "app not running" error. |
+------------------------------------------------------------------+
```

**Single-writer principle:** all writes (UI and AI) funnel through the
main-process service layer. One consistency owner, one migration owner,
and the open UI reflects AI changes live. The MCP<->app channel is the
core piece of design work.

---

## 6. Data model

`project`, `board`, `list`, `card`, `label`, `card_label`, `checklist`,
`checklist_item`, `comment`, `attachment`, `activity`, `template`.
- ids: UUIDv7 (`TEXT`) - sortable, no central sequence.
- ordering: a `position` fractional-index string on orderable rows -
  O(1) reorder, no renumbering or drift.
- `activity` records what changed and when (also feeds AI context).
- `comment.author` is nullable and tagged `ai` for AI-authored notes.
- `template` (JSON) - board/list blueprints.

The full schema lives in `/packages/db`.

---

## 7. MCP tool surface

All tools are `kanbini_`-prefixed, zod-validated, and routed through
main's `mutate` method on the control channel (the same discriminated
union as the renderer IPC), so adding one is a one-liner:

- **Read:** `kanbini_list_boards`, `kanbini_get_board`,
  `kanbini_get_card`, `kanbini_search_cards`.
- **Write:** `kanbini_create_board`, `kanbini_create_card`,
  `kanbini_update_card`, `kanbini_move_card`, `kanbini_delete_card`,
  `kanbini_set_card_labels`, `kanbini_post_comment` (forces
  `author='ai'`), `kanbini_create_checklist`,
  `kanbini_add_checklist_item`, `kanbini_toggle_checklist_item`.

Each write fires `broadcastChange(boardId)` so open renderers refetch and
AI edits appear live. Stdio transport means the same server works for any
MCP client without changes. See [`MCP.md`](MCP.md) for client setup and
the smoke/explore scripts.

---

## 8. Feature scope

**Included:** boards; lists (active/closed, colour, card limit, on-enter
automations); cards (title, Markdown description, due date + done state,
priority, cover); labels + filtering; checklists; comments; local
attachments; drag-and-drop reorder/move; swimlanes; board/list templates;
cross-board search + command palette; undo/redo; board backgrounds +
zoom; plain-text export/import; Trello import; settings; the MCP server.
Opt-in and off by default: link previews and one-way Obsidian export.

**Possible later:** custom fields; sub-tasks / linked cards; saved
filters and views; more AI-native helpers; optional encrypted cloud sync
for a future mobile companion.

**Out of scope by definition:** anything multi-user or online.

---

## 9. Packaging

electron-builder produces a Windows NSIS installer + a portable `.exe`;
macOS `.dmg` and Linux AppImage build from the same codebase (Windows is
the primary tested target). Auto-update is off; updates are a manual
download. `better-sqlite3` is the only native dependency (asar-unpacked).
Node-side DB tooling uses the built-in `node:sqlite` to avoid a dual-ABI
install. Code signing and macOS notarization are deferred, so builds ship
unsigned. First run creates the data dir, runs migrations, and seeds a
sample board. See [`PACKAGING.md`](PACKAGING.md).

---

## 10. Known limitations

- Kanban DnD polish (autoscroll, large-list virtualization, list-level
  drag) - the basics are in; the rest is deferred until a real board hits
  the limit.
- Undo of a cross-list card move does not reverse a list's on-enter
  automation (a two-step manual fix for now).
- Builds are unsigned (code signing deferred).
