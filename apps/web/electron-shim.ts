// Stands in for the `electron` module when the desktop main process
// (apps/desktop/src/main) runs under plain Node behind ./server.ts. Only
// what main actually calls is here: IPC handlers and the kanbini-file
// protocol become HTTP routes, native file dialogs return the file the
// browser uploaded with the request, and window sends reach every open tab.
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { version } from '../desktop/package.json'

type Handler = (event: unknown, arg: unknown) => unknown

/** The current HTTP request's upload: what a native dialog "picked". */
export const request = new AsyncLocalStorage<{ file?: string }>()
export const handlers = new Map<string, Handler>()
export const protocols = new Map<string, (req: Request) => Promise<Response>>()
export const windowListeners = new Set<(channel: string, payload: unknown) => void>()

// Windows, tray, menus, zoom and the session have nothing to drive in a
// browser; this absorbs any chain of calls on them. `then` stays undefined
// so an awaited call resolves instead of hanging.
const noop: any = new Proxy(function () {}, {
  get: (_t, key) => (key === 'then' || typeof key === 'symbol' ? undefined : noop),
  apply: () => noop,
  construct: () => noop
})

const paths: Record<string, string> = { userData: resolve('data') }
const appListeners: Record<string, ((event: { preventDefault(): void }) => void)[]> = {}

export const app = {
  // Unpackaged keeps main on its repo-relative paths (migrations, MCP bundle).
  isPackaged: false,
  getVersion: () => version,
  getPath: (name: string) => paths[name] ?? paths['userData']!,
  setPath: (name: string, path: string) => void (paths[name] = path),
  setName: () => {},
  setAppUserModelId: () => {},
  whenReady: () => Promise.resolve(),
  requestSingleInstanceLock: () => true,
  on(event: string, fn: (event: { preventDefault(): void }) => void) {
    ;(appListeners[event] ??= []).push(fn)
    return app
  },
  // main's before-quit runs the export + daily backup, then calls app.exit.
  quit() {
    const listeners = appListeners['before-quit'] ?? []
    if (listeners.length === 0) process.exit(0)
    for (const fn of listeners) fn({ preventDefault() {} })
  },
  exit: (code = 0) => process.exit(code)
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => app.quit())

export const ipcMain = { handle: (channel: string, fn: Handler) => void handlers.set(channel, fn) }

export const protocol = {
  registerSchemesAsPrivileged: () => {},
  handle: (scheme: string, fn: (req: Request) => Promise<Response>) => void protocols.set(scheme, fn)
}

const tabs = { webContents: { send: (channel: string, payload: unknown) => windowListeners.forEach((fn) => fn(channel, payload)) } }
export const BrowserWindow = Object.assign(function () { return noop }, {
  getAllWindows: () => [tabs],
  fromWebContents: () => null
})

export const dialog = {
  // Directory pickers get no upload, so they read as cancelled.
  showOpenDialog: async () => {
    const file = request.getStore()?.file
    return { canceled: !file, filePaths: file ? [file] : [] }
  },
  // Board export writes here; the browser then downloads it from /download/.
  showSaveDialog: async (...args: { defaultPath?: string }[]) => {
    const dir = join(app.getPath('userData'), 'downloads')
    mkdirSync(dir, { recursive: true })
    return { canceled: false, filePath: join(dir, basename(args.at(-1)?.defaultPath ?? 'export')) }
  },
  showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
  showErrorBox: (title: string, content: string) => console.error(title, content)
}

// Paste: the browser uploads the pasted image (always PNG from a clipboard).
export const clipboard = {
  readImage() {
    const file = request.getStore()?.file
    const png = file ? readFileSync(file) : Buffer.alloc(0)
    return { isEmpty: () => png.length === 0, toPNG: () => png }
  }
}

export const shell = {
  openExternal: async () => {},
  showItemInFolder: () => {},
  openPath: async () => 'Not available in the browser version.'
}

export const Menu = noop
export const Tray = noop
export const nativeImage = noop
export const screen = noop
export const session = noop
