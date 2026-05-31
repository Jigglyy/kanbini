// @kanbini/shared - domain types, id/order utils, and (later) the zod
// schemas shared across IPC, MCP, and the DB layer. Kept dependency-
// light and electron-agnostic.

/** Product name (codename Konbini until 2026-05-21, then renamed to
 *  Kanbini - a portmanteau of "konbini" + "kanban"). Used by Electron
 *  as the app name and by the MCP server to locate userData. */
export const APP_CODENAME = "Kanbini";

/** Bumped whenever the persisted SQLite shape changes (schema v1). */
export const SCHEMA_VERSION = 1 as const;

export * from "./channels";
export * from "./html";
export * from "./id";
export * from "./mutations";
export * from "./net";
export * from "./obsidian";
export * from "./order";
export * from "./templates";
export * from "./text";
export * from "./trello";
export * from "./views";
