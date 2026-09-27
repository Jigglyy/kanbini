---
name: agenda
description: Show what's overdue, due today, coming up, and recently completed across all your Kanbini boards.
argument-hint: "[days ahead]"
disable-model-invocation: true
allowed-tools: mcp__plugin_kanbini_kanbini__kanbini_get_agenda
---

Call `kanbini_get_agenda`. If `$ARGUMENTS` is a whole number from 1 to 60,
pass it as `upcomingDays`; otherwise use the defaults.

Show the result compactly, in this order, skipping empty sections:

1. **Overdue**: title, board, and how late it is ("2 days late").
2. **Due today**: title and board, most urgent first.
3. **Coming up**: title, board, and the day it's due.
4. **Recently completed**: just the count, plus the titles if there are
   five or fewer.

Mention a card's priority only when it's high or urgent, and mark cards
with `blocked: true` as waiting on another card. If a section was
cut short (`totals` is bigger than what came back), say how many more
there are.

If everything is empty, say there's nothing due in the window and that
cards show up here once they have a due date.

Don't change anything. End by offering to help plan the day or to
reschedule anything overdue.
