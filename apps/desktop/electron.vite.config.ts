import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// Renderer source lives in its own workspace (ADR-0010); electron-vite
// just orchestrates it. @kanbini/* are TS-source workspace packages, so
// they must be bundled (excluded from externalize).
const rendererRoot = resolve(__dirname, '../renderer')
const workspacePkgs = ['@kanbini/shared', '@kanbini/db']

// A custom `rollupOptions.external` REPLACES electron-vite's defaults,
// so it must be a full superset:
//  - 'electron': provided by the runtime; bundling its npm launcher
//    (getElectronPath) crashes main at load.
//  - 'better-sqlite3': native .node, resolved at runtime (Electron ABI,
//    ADR-0012); pulled in via the bundled @kanbini/db.
//  - node builtins (bare + 'node:' forms): never bundle these.
const externals = [
  'electron',
  'better-sqlite3',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`)
]

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePkgs })],
    build: {
      outDir: 'out/main',
      lib: { entry: resolve(__dirname, 'src/main/index.ts') },
      rollupOptions: { external: externals }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePkgs })],
    build: {
      outDir: 'out/preload',
      lib: { entry: resolve(__dirname, 'src/preload/index.ts') },
      rollupOptions: { external: externals }
    }
  },
  renderer: {
    root: rendererRoot,
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': resolve(rendererRoot, 'src') }
    },
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      emptyOutDir: true,
      rollupOptions: { input: resolve(rendererRoot, 'index.html') }
    }
  }
})
