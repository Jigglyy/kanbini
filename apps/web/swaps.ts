export type Swap = [from: string | RegExp, to: string | ((match: string) => string)]

// The desktop UI, changed for the browser build. Each swap must match, so
// an upstream rewording fails the build instead of leaving desktop-only
// controls or wrong claims on screen. vite.config.ts applies them, and
// repo-guards.test.ts runs them in `pnpm test`, so a rewording fails
// `pnpm verify` on the desktop side, not just the next Docker build.
// Files are relative to apps/renderer/src.
export const WEB_SWAPS: Record<string, Swap[]> = {
  // The account menu goes right after the header's Settings button.
  'App.tsx': [
    [/<Settings className="size-4" \/>\s*<\/button>\s*<\/Tooltip>/, (button) => `${button}\n<KanbiniAccountMenu />`]
  ],
  'components/app-settings.tsx': [
    // No window or tray in a browser, and no vault folder on the server.
    [/,\s*\{ id: 'window', label: 'Window' \}/, ''],
    [/\{ id: 'obsidian', label: 'Obsidian' \},\s*/, ''],
    // Settings > MCP: this server's HTTPS endpoint (gateway.ts answers mcp:info),
    // not the desktop app's loopback channel and plugin.
    ['<Section title="MCP control channel">', '<Section title="MCP endpoint">'],
    ['Loopback only. The token blocks other local processes.', 'Your personal token for this server. Treat it like a password.'],
    [/Skip the snippet and install the Kanbini plugin instead\.[\s\S]*?Needs Node\.js on your computer\./, 'Or run this in a terminal to add Kanbini to Claude Code.'],
    [
      'text={CLAUDE_CODE_PLUGIN_COMMANDS}',
      'text={`claude mcp add --transport http kanbini ${info.paths.mcpJson} --header "Authorization: Bearer ${info.channel.token}"`}'
    ],
    ['<Section title="Files">', '<Section title="Connection">'],
    ['label="mcp.json"', 'label="URL"'],
    ['<DetailRow label="Token" value={info.paths.mcpToken} />', '<DetailRow label="Header" value={info.paths.mcpToken} />'],
    ['label="Server bundle"', 'label="Workspace"'],
    // Backup & restore: the export and restore folders are on the server,
    // where nobody can open them. The daily backups list stays.
    [/<Section title="Backup">[\s\S]*?<\/Section>/, ''],
    [/<Section title="Restore">[\s\S]*?<\/Section>/, ''],
    [/\{info && \(\s*<Section title="Data location">[\s\S]*?<\/Section>\s*\)\}/, ''],
    ['<BackupList folder={info?.paths.backups} />', '<BackupList />'],
    // About: no Electron, no server paths, no bundled NOTICES.md; and not a
    // desktop app on your machine.
    [/Offline desktop kanban\.[\s\S]*?stays on your machine\./, 'Kanbini in your browser, on a server you run. No telemetry: your boards stay on this server.'],
    [/<Section title="Runtime">[\s\S]*?<\/Section>/, ''],
    [/<Section title="Data location">[\s\S]*?<\/Section>/, ''],
    [/<Section title="Third-party software">[\s\S]*?<\/Section>/, '']
  ],
  // On a desktop the files sit in a folder on your own computer; in a browser
  // they have to be downloadable. The name is a link (works on phones too),
  // and the row's actions get a Download button beside Make cover.
  'components/attachments.tsx': [
    [
      '<span className="truncate text-sm">{att.filename}</span>',
      '<a href={srcFor(att)} download={att.filename} title="Download" className="truncate text-sm hover:underline">{att.filename}</a>'
    ],
    [
      /<button\s+aria-label="Delete attachment"/,
      (button) =>
        `<a href={srcFor(att)} download={att.filename} className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">Download</a>\n${button}`
    ]
  ],
  'components/backup-list.tsx': [
    ['The first one is made when you next close Kanbini.', 'The first one is made within the hour.']
  ],
  // The browser downloads the file; the server folder it was written to means nothing here.
  'components/board-export.tsx': [
    ["import { FolderOpen } from 'lucide-react'", "import { Download as FolderOpen } from 'lucide-react'"],
    ['const { name, folder } = splitPath(saved.path)', "const { name } = splitPath(saved.path)\n    const folder = ''"],
    ['Saved as <strong', 'Downloaded <strong'],
    ['Show in folder', 'Download again']
  ],
  // The welcome dialog's claims, made true for a shared server.
  'components/welcome-modal.tsx': [
    [/A local-first kanban for one\.[\s\S]*?unless you opt in\./, 'Kanbini in your browser. Your own boards are private; workspaces share boards with people you invite.'],
    ['title="Offline by default"', 'title="Private by default"'],
    ['body="No accounts, no telemetry, no auto-update pings."', 'body="No telemetry. Only you see your own boards; a workspace’s members see its boards."'],
    [
      'body="Settings → Backup & restore exports a plain-text snapshot of everything (also runs on quit)."',
      'body="Kanbini keeps a backup of everything every day for 7 days. Restore one from Settings → Backup & restore."'
    ],
    [
      'body="Link previews, an Obsidian one-way push, and a local MCP channel so an AI can drive the board live, all off by default."',
      'body="Link previews, and MCP so an AI can work on your boards live. Both off until you set them up."'
    ]
  ]
}

/** Rewrites one renderer source file for the browser: kanbini-file:// (an
 *  Electron-only scheme) becomes the server's /kanbini-file/ route, then the
 *  file's swaps apply in order. `missing` lists every swap target that is no
 *  longer in the file; the build refuses to continue with any. */
export function rewriteForBrowser(file: string, code: string): { code: string; missing: (string | RegExp)[] } {
  let out = code.replaceAll('kanbini-file://', '/kanbini-file/')
  const missing: (string | RegExp)[] = []
  for (const [from, to] of WEB_SWAPS[file] ?? []) {
    if (!(typeof from === 'string' ? out.includes(from) : from.test(out))) {
      missing.push(from)
      continue
    }
    out = out.replace(from, typeof to === 'string' ? () => to : to) // a function: `to` may hold ${...} meant for the TSX
  }
  return { code: out, missing }
}
