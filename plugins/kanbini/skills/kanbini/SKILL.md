---
name: kanbini
description: Conventions for reading and changing the user's Kanbini kanban boards through the kanbini MCP tools. Use whenever the user mentions Kanbini, their board, cards, lists, tasks on their board, or asks what to work on next.
user-invocable: false
---

# Working with Kanbini

Kanbini is an offline kanban desktop app running on the user's own
computer. The `kanbini` MCP tools talk to that app: every change shows up
live in its window (the cards you touch glow briefly), and one Ctrl+Z on
a board takes back everything you changed there since the user last
edited it themselves. Nothing is sent anywhere else.

## Finding things

- Never guess an id, and you rarely need one: boards, lists and labels
  can be named by their exact name, and cards by number (#142), with
  `boardId` (a board's id or name). `kanbini_list_boards` lists the
  boards, and `kanbini_search_cards` finds a card by words in its title,
  description, or label names.
- `kanbini_get_board` gives one short line per card (number, title, and
  only what applies: due, priority, labels, checklist progress, ...), so
  it works on big boards. Read one card in full with `kanbini_get_card`.
  For one list, filtered (open or done, a label, a priority, a due range,
  some text) or a page at a time, use `kanbini_get_list_cards`. Avoid
  `detail: "full"` on a big board.
- Every card has a short number the app shows on it, like #142 (`number`
  in reads), counted per board: each board has its own #1, #2, ...
  Users refer to cards that way. `kanbini_get_card` and every write
  tool that takes a card accept `#142` plus the card's `boardId` in
  place of an id. Don't reuse a
  number from earlier in a long session without its board; look the
  card up again. When you mention a card to the user, add its number,
  e.g. "Fix login redirect (#142)", and name its board when the
  conversation spans more than one. Anything you write down for later
  (a comment, a description, notes) names the board with the number,
  e.g. "#142 on Website", since every board has a #142.
- For "what's due", "what's overdue", "what should I work on", or "what
  did I get done", call `kanbini_get_agenda` once. It covers every board,
  so don't walk the boards one by one.
- Boards are the top level. The data also has projects, but the app hides
  them: ignore `projectId`.

## Changing things

- More than one change? Use `kanbini_batch`: one call, all-or-nothing,
  and one Ctrl+Z in the app undoes it. Its steps take the same arguments
  as the matching tools; give the batch a `boardId` so steps can name
  cards by number and lists / labels by name, and use `ref` / `"$ref"`
  to point at something an earlier step made.
- Make a card in one `kanbini_create_card` call: it takes the
  description, due date, priority, labels, checklists and position too.
- Move a card with `kanbini_move_card`, to any list on any board (its
  labels follow by name). Don't delete and recreate it: that loses its
  comments, checklists, attachments, and history. For a copy, use
  `kanbini_copy_card`.
- Prefer archiving (`kanbini_archive_card`, `kanbini_archive_list`) over
  deleting. Tell the user what you archived: they can see and restore
  it in the app from the board's pencil menu > Archived..., and
  `kanbini_list_archived` finds it again.
- Due dates: pass `due` as a day, YYYY-MM-DD (or `dueAt`, epoch ms at
  LOCAL midnight of the due day). Reads show `due` the same way.
- Priority is `low`, `medium`, `high`, `urgent`, or null.
- Repeating cards: set `repeat: { unit: 'day' | 'week' | 'month' |
  'year', every }` with `kanbini_update_card`. Completing one makes the
  app add the next occurrence itself, so don't create it by hand.
- Colours accept palette names: red, orange, amber, yellow, lime, green,
  teal, cyan, sky, blue, indigo, purple, pink, rose. Use a name, not a
  made-up CSS colour, so it matches the app's colour pickers.
- "Waiting on" links: `kanbini_add_blocker` makes a card wait on another
  (any board). A card is blocked while any of its `blockedBy` cards is
  still open, so don't suggest starting it; suggest its blocker instead.
  Loops are rejected. `kanbini_get_agenda` marks blocked cards.
- Labels belong to one board. Use existing labels when they clearly fit;
  ask before creating new ones.
- Your comments are marked as written by the AI, so write them in your
  own voice.
- Don't create boards unless the user asks for one.
- Confirm before deleting anything, and before changing more than a
  handful of cards at once.
- After a change, say briefly what you did and where (board and list).

## When a tool fails

- A read that starts with `[NOTE]` came from the last saved snapshot
  because the app is closed. It may be out of date, and changes need the
  app open, so ask the user to open Kanbini.
- If the kanbini tools are missing or the server didn't start, the user
  needs to install Kanbini and open it once (it registers its MCP server
  when it starts), then run `/mcp` to reconnect.
