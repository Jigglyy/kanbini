import type { Mutation } from "./mutations";

// What the read-only board lock (ADR-0089) lets through. The lock guards
// a board's CONTENT; two kinds of write don't change it:
//
//   - ticks: a card's or a checklist item's `completed`, alone, so a
//     locked board can still be worked through;
//   - view settings: how the board is drawn, not what's on it. These are
//     the same fields the undo log and `updatedAt` already ignore
//     (packages/db crud.ts), so they live here as the one list.
//
// Used by the renderer's guard (lib/ipc.ts, useBoardMutation) and by the
// undo log, which refuses an undo / redo that would change a locked
// board (packages/db undo.ts).

/** card.update fields that only change how the card is drawn. */
export const CARD_VIEW_FIELDS: ReadonlySet<string> = new Set(["collapsed"]);
/** list.update fields that only change how the list is drawn. */
export const LIST_VIEW_FIELDS: ReadonlySet<string> = new Set([
  "cardDensity",
  "visibleCardLimit",
]);
/** board.update fields that only change how the board is drawn or where
 *  it sits on the home screen. */
export const BOARD_VIEW_FIELDS: ReadonlySet<string> = new Set([
  "swimlaneMode",
  "pinned",
]);

function onlyFields(
  patch: Record<string, unknown>,
  fields: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(patch);
  return keys.length > 0 && keys.every((k) => fields.has(k));
}

/** Ticking a card or a checklist item done / not done, and nothing else
 *  in the same patch. */
export function isTick(m: Mutation): boolean {
  if (m.type !== "checklistItem.update" && m.type !== "card.update") {
    return false;
  }
  const keys = Object.keys(m.patch);
  return keys.length === 1 && keys[0] === "completed";
}

/** A patch of view settings only (collapse, list density, "Show at
 *  most", Group by, favourite). */
export function isViewChange(m: Mutation): boolean {
  if (m.type === "card.update") return onlyFields(m.patch, CARD_VIEW_FIELDS);
  if (m.type === "list.update") return onlyFields(m.patch, LIST_VIEW_FIELDS);
  if (m.type === "board.update") return onlyFields(m.patch, BOARD_VIEW_FIELDS);
  return false;
}

/** A write the read-only lock lets through: it leaves the board's
 *  content as it was. */
export function passesReadOnlyLock(m: Mutation): boolean {
  return isTick(m) || isViewChange(m);
}
