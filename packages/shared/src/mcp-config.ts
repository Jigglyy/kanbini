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
 *
 *  Known limit: the portable .exe unpacks to a fresh temp directory
 *  each launch, so both paths in a portable build's snippet go stale
 *  when it's relaunched. Installed builds are stable. */
export function buildMcpClientSnippet(input: McpSnippetInput): string {
  const args = [input.bundle ?? MCP_BUNDLE_PLACEHOLDER];
  const server = input.isPackaged
    ? {
        command: input.execPath,
        args,
        env: { ELECTRON_RUN_AS_NODE: "1" },
      }
    : { command: "node", args };
  return JSON.stringify({ mcpServers: { kanbini: server } }, null, 2);
}
