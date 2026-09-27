---
name: log
description: Log the work done in this session as a completed card on a Kanbini board.
argument-hint: "[board]"
disable-model-invocation: true
allowed-tools: mcp__plugin_kanbini_kanbini__kanbini_list_boards, mcp__plugin_kanbini_kanbini__kanbini_get_board, mcp__plugin_kanbini_kanbini__kanbini_create_card, mcp__plugin_kanbini_kanbini__kanbini_update_card, Bash(git log *), Bash(git diff *), Bash(git status *)
---

Record what we did in this session as a completed card in Kanbini.

**Work out what was done** from this conversation. If this is a git
repository, `git log`, `git diff --stat`, and `git status` can fill in
what changed; read them, don't change anything in the repository. If
nothing was done in this session, say so and stop.

**Pick the board** with `kanbini_list_boards` (ignore archived boards):

1. The board named here, if any: $ARGUMENTS
2. Otherwise, a board whose name matches this project's folder
   (`${CLAUDE_PROJECT_DIR}`).
3. Otherwise, the only board, if there's just one.
4. Otherwise, ask which board. Don't guess, and don't create a board.

**Pick the list** with `kanbini_get_board`: one whose name means finished
(Done, Complete, Shipped, and so on). If there isn't one, ask which list
to use.

**Write the card:**

- Title: what was achieved, in a few words ("Add agenda to home screen").
- Description (set with `kanbini_update_card`), in Markdown:
  - **What changed**: a few bullets, naming files or features.
  - **Why**: one or two sentences.
  - **Follow-ups**: anything left to do, if there is any.
- Mark it complete with `kanbini_update_card` (`completed: true`).

Then say which board and list you used. If there are follow-ups, offer to
add each one as its own open card, and only add them if the user says
yes.
