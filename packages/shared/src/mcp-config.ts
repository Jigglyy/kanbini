// Pure builder for the MCP client config block Settings → AI
// integration renders. Lives here (not in main) for the same reason
// the Obsidian note helpers do: it's decision logic worth pinning in
// the Vitest harness, and it needs nothing from Electron beyond two
// values the caller reads off `app` / `process`.

/** What the caller knows about the running app. `execPath` is
 *  `process.execPath`; `bundle` is the resolved absolute path to the
 *  MCP server bundle, or null when it hasn't been built yet. */
export interface McpSnippetInput {
  isPackaged: boolean;
  execPath: string;
  bundle: string | null;
  /** Run the server on the system's `node` even though packaged. Set
   *  when `runsFromTempFolder` (the one-file portable exe, ADR-0073, and
   *  a Linux AppImage), whose own binary lives in a folder that's gone
   *  once the app closes: a client pointed at it loses the server after
   *  each run, and a server still running from the exe's folder keeps
   *  it locked so it's never cleaned up. `bundle` is then a copy staged
   *  somewhere that outlives the run. */
  systemNode?: boolean;
}

/** True when this packaged copy runs out of a folder that disappears
 *  once the app closes, so nothing long-lived may point at
 *  `process.execPath`:
 *
 *  - the one-file portable exe (ADR-0073): its wrapper unpacks the app
 *    into a fresh %TEMP% folder, sets `PORTABLE_EXECUTABLE_FILE`, and
 *    deletes the folder on exit;
 *  - a Linux AppImage: it mounts itself at a new `/tmp/.mount_*` folder
 *    on every launch, sets `APPIMAGE`, and unmounts it on exit.
 *
 *  Dev runs are never one, whatever the environment says. */
export function runsFromTempFolder(
  isPackaged: boolean,
  env: Record<string, string | undefined>,
): boolean {
  return (
    isPackaged &&
    Boolean(env["PORTABLE_EXECUTABLE_FILE"] || env["APPIMAGE"])
  );
}

/** True when the server runs on the system's `node`, so Node.js has to
 *  be installed for an AI to start it (dev, the one-file exe, and an
 *  AppImage). */
export function mcpServerNeedsNode(input: McpSnippetInput): boolean {
  return !input.isPackaged || input.systemNode === true;
}

/** Placeholder used when the bundle isn't on disk, so the snippet
 *  still shows the right SHAPE instead of pretending or rendering
 *  "null". Only reachable in dev (a packaged build always ships the
 *  bundle - `check-payload` fails the release otherwise). */
export const MCP_BUNDLE_PLACEHOLDER =
  "<absolute path to apps/mcp/dist/index.js>";

/** Build the `{ mcpServers: { kanbini: … } }` block the user pastes
 *  into whatever client they hook up. Most MCP-capable AIs accept the
 *  same shape (Claude Desktop, Claude Code, etc.); where exactly it
 *  goes is client-specific, so the UI defers that to the user's AI.
 *
 *  The interpreter differs by build:
 *
 *  - **Packaged**: our own Electron binary with
 *    `ELECTRON_RUN_AS_NODE=1`, which makes Electron run as a plain
 *    Node runtime. The snippet used to hardcode `node`, which assumed
 *    every user who installs a self-contained desktop app also has
 *    Node.js on PATH. Most don't, and when they don't, the client
 *    reports a bare spawn failure that names nothing useful. The app
 *    already ships a Node runtime inside Electron - use it.
 *  - **Dev**: plain `node`. `process.execPath` in dev is the
 *    node_modules Electron dev binary, a worse thing to paste into a
 *    long-lived client config than the `node` a developer already has.
 *  - **One-file portable exe / AppImage** (`systemNode`): plain `node`
 *    too, on a staged copy of the bundle, since their own binary lives in
 *    a temp folder that's gone on every exit (see `runsFromTempFolder`).
 *
 *  The paths are as stable as the app's folder: the installer, the
 *  portable folder (ADR-0071), the macOS .app and the .deb hold until
 *  that folder is moved or replaced; a staged copy holds for good. */
export function buildMcpClientSnippet(input: McpSnippetInput): string {
  const server = buildMcpServerEntry({
    ...input,
    bundle: input.bundle ?? MCP_BUNDLE_PLACEHOLDER,
  });
  return JSON.stringify({ mcpServers: { kanbini: server } }, null, 2);
}

/** How to start this app's MCP server: the `{ command, args, env? }`
 *  entry an MCP client config holds. Shared by the Settings snippet and
 *  the launch pointer file below so the two can't disagree. */
export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export function buildMcpServerEntry(
  input: McpSnippetInput & { bundle: string },
): McpServerEntry {
  const args = [input.bundle];
  return mcpServerNeedsNode(input)
    ? { command: "node", args }
    : { command: input.execPath, args, env: { ELECTRON_RUN_AS_NODE: "1" } };
}

/** File in `<userData>` that tells the Claude Code plugin's launcher
 *  how to start the INSTALLED app's MCP server. Main rewrites it on
 *  every launch (so an update or a moved install re-points it) and,
 *  unlike `mcp.json`, never deletes it on quit: the server's headless
 *  fallback reads the export while the app is closed. Holds no secret;
 *  the bearer token stays in `mcp-token`. */
export const MCP_SERVER_POINTER_FILE = "mcp-server.json";

export interface McpServerPointer extends McpServerEntry {
  /** App version that wrote the pointer (diagnostics only). */
  version: string;
  writtenAt: number;
}

export function buildMcpServerPointer(
  input: McpSnippetInput & { bundle: string; version: string; now?: number },
): McpServerPointer {
  return {
    ...buildMcpServerEntry(input),
    version: input.version,
    writtenAt: input.now ?? Date.now(),
  };
}
