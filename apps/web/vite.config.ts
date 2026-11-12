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
import { rewriteForBrowser, WEB_SWAPS } from './swaps'

const renderer = resolve(__dirname, '../renderer')
const src = (file: string) => resolve(renderer, 'src', file)

// The renderer's sources, rewritten for the browser (./swaps.ts). Also: the
// bridge loads before the app, and Tailwind reads apps/web too (the account
// menu, the sign-in pages' classes).
const forBrowser: Plugin = {
  name: 'kanbini-for-browser',
  enforce: 'pre',
  transform(code, id) {
    if (!id.startsWith(src(''))) return
    const file = Object.keys(WEB_SWAPS).find((f) => id === src(f)) ?? ''
    const rewritten = rewriteForBrowser(file, code)
    if (rewritten.missing.length) {
      this.error(`${file} changed upstream; update WEB_SWAPS in apps/web/swaps.ts: ${rewritten.missing.join(', ')}`)
    }
    let out = rewritten.code
    if (id.split('?')[0] === src('index.css')) out += '\n@source "../../web/*.{ts,tsx}";\n'
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
