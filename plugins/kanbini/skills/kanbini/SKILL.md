---
name: kanbini
description: Conventions for reading and changing the user's Kanbini kanban boards through the kanbini MCP tools. Use whenever the user mentions Kanbini, their board, cards, lists, tasks on their board, or asks what to work on next.
user-invocable: false
---

# Working with Kanbini

Kanbini is an offline kanban desktop app running on the user's own
computer. The `kanbini` MCP tools talk to that app: every change shows up
live in its window, and the user can undo any of it there with Ctrl+Z.
Nothing is sent anywhere else.

## Finding things

- Never guess an id. Board ids come from `kanbini_list_boards`, list and
  card ids from `kanbini_get_board`, and `kanbini_search_cards` finds a
  card by words in its title, description, or label names.
- For "what's due", "what's overdue", "what should I work on", or "what
  did I get done", call `kanbini_get_agenda` once. It covers every board,
  so don't walk the boards one by one.
- Boards are the top level. The data also has projects, but the app hides
  them: ignore `projectId`.

## Changing things

- Move a card with `kanbini_move_card`. Don't delete and recreate it:
  that loses its comments, checklists, attachments, and history.
- Prefer archiving (`kanbini_archive_card`, `kanbini_archive_list`) over
  deleting. The app has no screen for archived items yet, so tell the
  user what you archived; `kanbini_list_archived` finds it again.
- Due dates are epoch milliseconds at LOCAL midnight of the due day.
- Priority is `low`, `medium`, `high`, `urgent`, or null.
- Colours accept palette names: red, orange, amber, yellow, lime, green,
  teal, cyan, sky, blue, indigo, purple, pink, rose. Use a name, not a
  made-up CSS colour, so it matches the app's colour pickers.
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
