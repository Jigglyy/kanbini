---
name: new-card
description: Add a card to one of your Kanbini boards from a quick description.
argument-hint: "<what the card is for>"
disable-model-invocation: true
allowed-tools: mcp__plugin_kanbini_kanbini__kanbini_list_boards, mcp__plugin_kanbini_kanbini__kanbini_get_board, mcp__plugin_kanbini_kanbini__kanbini_create_card, mcp__plugin_kanbini_kanbini__kanbini_update_card, mcp__plugin_kanbini_kanbini__kanbini_set_card_labels
---

Create a Kanbini card for: $ARGUMENTS

If that's empty, ask what the card should say and stop.

**Pick the board** with `kanbini_list_boards` (ignore archived boards):

1. A board the request names.
2. Otherwise, the only board, if there's just one.
3. Otherwise, a board whose name matches this project's folder
   (`${CLAUDE_PROJECT_DIR}`).
4. Otherwise, ask which board, listing the choices. Don't guess, and
   don't create a board.

**Pick the list** with `kanbini_get_board`: a list the request names,
otherwise the first open list (usually something like To Do or Backlog).

**Write the card:**

- Title: short and specific, under about 80 characters.
- Anything longer (context, steps, links) goes in the description as
  Markdown, set with `kanbini_update_card` after creating the card.
- A due date only if the request gives one ("by Friday"): epoch
  milliseconds at local midnight of that day.
- A priority only if the request implies one ("urgent", "when there's
  time" means low).
- Existing labels on that board that clearly fit. Don't create labels.

Then say which board and list it went to, and the title you used.
