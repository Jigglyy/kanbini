// Three builds from unchanged desktop sources:
//   vite build -c apps/web/vite.config.ts                             -> out/web (the renderer)
//   vite build -c apps/web/vite.config.ts --ssr apps/web/gateway.ts   -> out/server/gateway.cjs
//   vite build -c apps/web/vite.config.ts --ssr apps/web/server.ts    -> out/server/server.cjs
// Separate builds keep each bundle whole: built together, the gateway
// would load the app's shared chunk, startup code and all.
// out/server sits four levels under the repo root, like apps/desktop/out/main,
// so main's repo-relative paths (packages/db/drizzle, apps/mcp/dist) resolve.
import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin, type UserConfig } from 'vite'

const renderer = resolve(__dirname, '../renderer')
const src = (file: string) => resolve(renderer, 'src', file)

type Swap = [from: string | RegExp, to: string | ((match: string) => string)]

// The desktop UI, changed for the browser build. Each swap must match, so
// an upstream rewording fails the build instead of leaving desktop-only
// controls or wrong claims on screen. Files are relative to apps/renderer/src.
const WEB_SWAPS: Record<string, Swap[]> = {
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

// Also: the bridge loads before the app, kanbini-file:// (an Electron-only
// scheme) points at the server's /kanbini-file/ route, and Tailwind reads
// apps/web too (the account menu, the sign-in pages' classes).
const forBrowser: Plugin = {
  name: 'kanbini-for-browser',
  enforce: 'pre',
  transform(code, id) {
    if (!id.startsWith(src(''))) return
    let out = code.replaceAll('kanbini-file://', '/kanbini-file/')
    if (id.split('?')[0] === src('index.css')) out += '\n@source "../../web/*.{ts,tsx}";\n'
    for (const [file, swaps] of Object.entries(WEB_SWAPS)) {
      if (id !== src(file)) continue
      for (const [from, to] of swaps) {
        if (!(typeof from === 'string' ? out.includes(from) : from.test(out))) {
          this.error(`${file} changed upstream; update WEB_SWAPS in apps/web/vite.config.ts: ${from}`)
        }
        out = out.replace(from, typeof to === 'string' ? () => to : to) // a function: `to` may hold ${...} meant for the TSX
      }
    }
    if (id === src('App.tsx')) {
      out = `import { AccountMenu as KanbiniAccountMenu } from ${JSON.stringify(resolve(__dirname, 'account-menu'))}\n${out}`
    }
    return id === src('main.tsx') ? `import ${JSON.stringify(resolve(__dirname, 'bridge.ts'))}\n${out}` : out
  }
}

export default defineConfig(({ isSsrBuild }): UserConfig =>
  isSsrBuild
    ? {
        resolve: { alias: { electron: resolve(__dirname, 'electron-shim.ts') } },
        // Bundle everything but the native SQLite binding.
        ssr: { noExternal: true },
        build: {
          outDir: resolve(__dirname, 'out/server'),
          emptyOutDir: false, // the two server builds share it
          rollupOptions: {
            external: ['better-sqlite3', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
            output: { format: 'cjs', entryFileNames: '[name].cjs', inlineDynamicImports: true }
          }
        }
      }
    : {
        root: renderer,
        plugins: [forBrowser, react(), tailwindcss()],
        // One React: the account menu (apps/web) and the app share hooks' state.
        resolve: { alias: { '@': resolve(renderer, 'src') }, dedupe: ['react', 'react-dom'] },
        build: { outDir: resolve(__dirname, 'out/web'), emptyOutDir: true }
      }
)
