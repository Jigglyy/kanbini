// Browser stand-in for the desktop preload bridge
// (apps/desktop/src/preload/index.ts): the same `window.kanbini` API, sent
// to ./server.ts over HTTP. Where desktop opens a native file dialog, this
// opens the browser's file picker and uploads the file with the call.
// By path: one import-free file, not worth a dependency on @kanbini/shared.
import { IPC } from '../../packages/shared/src/channels'

/** This tab's workspace, read once at load (the gateway sets the cookie with
 *  the page). Every call goes to /w/<id>/..., so switching workspace in
 *  another tab never sends this tab's edits somewhere else. */
const space = /(?:^|;\s*)kanbini_space=([0-9a-f]{16})/.exec(document.cookie)?.[1]
export const base = space ? `/w/${space}` : ''

/** Never settles: the page is leaving. */
function leave(to: string): Promise<never> {
  location.assign(to)
  return new Promise(() => {})
}

async function call(channel: string, arg?: unknown, file?: File): Promise<any> {
  // location.origin: fetch rejects URLs that inherit user:pass@ from the page URL.
  const res = await fetch(`${location.origin}${base}/api/${channel}`, {
    method: 'POST',
    headers: file
      ? {
          'x-kanbini-filename': encodeURIComponent(file.name || 'upload'),
          'x-kanbini-arg': encodeURIComponent(JSON.stringify(arg ?? null))
        }
      : { 'content-type': 'application/json' },
    // No body = undefined, as ipcRenderer.invoke(channel) delivers it.
    body: file ?? (arg === undefined ? undefined : JSON.stringify(arg))
  })
  if (res.status === 401) return leave('/login') // signed out (expired, or elsewhere)
  if (res.status === 410) return leave('/') // removed from this tab's workspace
  if (!res.ok) throw new Error((await res.text()) || `${channel} failed (${res.status})`)
  return res.json()
}

/** The browser's file picker; null on cancel (like a cancelled native dialog). */
function pickFile(accept = ''): Promise<File | null> {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept })
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null))
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
}
const upload = (channel: string, arg: unknown, accept?: string) =>
  pickFile(accept).then((file) => (file ? call(channel, arg, file) : null))

/** Desktop reads the OS clipboard on the Ctrl/Cmd+V keydown; a page only
 *  sees it in the paste event that follows. */
function nextPastedImage(): Promise<File | null> {
  return new Promise((resolve) => {
    const onPaste = (e: ClipboardEvent) => {
      clearTimeout(timer)
      resolve([...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/')) ?? null)
    }
    const timer = setTimeout(() => {
      removeEventListener('paste', onPaste, true)
      resolve(null)
    }, 1000)
    addEventListener('paste', onPaste, { capture: true, once: true })
  })
}

const download = (path: string) =>
  location.assign(`${base}/download/${encodeURIComponent(path.split(/[\\/]/).pop() ?? '')}`)

const unavailable = (what: string) => async () => {
  alert(`${what} isn't available in the browser version.`)
  return null
}

const changeListeners = new Set<(e: unknown) => void>()
let connectedBefore = false
const events = new EventSource(`${base}/api/events`)
events.addEventListener(IPC.changed, (e) =>
  changeListeners.forEach((cb) => cb(JSON.parse((e as MessageEvent).data)))
)
// After a dropped connection (sleep, proxy restart) changes may have been
// missed: boardId null tells the renderer to refetch everything.
events.addEventListener('open', () => {
  if (connectedBefore) changeListeners.forEach((cb) => cb({ boardId: null }))
  connectedBefore = true
})

const pass = (channel: string) => (arg?: unknown) => call(channel, arg)

;(window as any).kanbini = {
  versions: { electron: '', chrome: '' },
  listBoards: pass(IPC.boardsList),
  getBoardView: (boardId?: string) => call(IPC.boardGetView, { boardId }),
  mutate: pass(IPC.mutate),
  mutateBatch: pass(IPC.mutateBatch),
  attachmentAdd: (cardId: string) => upload(IPC.attachmentAdd, { cardId }),
  attachmentPasteImage: async (cardId: string) => {
    const image = await nextPastedImage()
    return image ? call(IPC.attachmentPasteImage, { cardId }, image) : null
  },
  linkPreviewCreate: pass(IPC.linkPreviewCreate),
  exportNow: pass(IPC.exportNow),
  importFolder: unavailable('Restoring from an export folder (use a backup from the list instead)'),
  backupsList: pass(IPC.backupsList),
  backupsRestore: pass(IPC.backupsRestore),
  importTrello: () => upload(IPC.importTrello, null, '.json,application/json'),
  boardExport: async (req: unknown) => {
    const result = await call(IPC.boardExport, req)
    if (result) download(result.path)
    return result
  },
  boardImport: () => upload(IPC.boardImport, null, '.kanbini'),
  showInFolder: ({ path }: { path: string }) => download(path),
  windowPrefs: pass(IPC.windowPrefs),
  setWindowPrefs: pass(IPC.windowPrefsSet),
  setRecentBoards: pass(IPC.trayRecentBoards),
  boardSetBackgroundImage: (req: unknown) => upload(IPC.boardSetBackgroundImage, req, 'image/*'),
  undoStatus: pass(IPC.undoStatus),
  undoApply: pass(IPC.undoApply),
  redoApply: pass(IPC.redoApply),
  undoClear: pass(IPC.undoClear),
  searchCards: pass(IPC.searchCards),
  agenda: pass(IPC.agenda),
  archivedItems: pass(IPC.archivedItems),
  appInfo: pass(IPC.appInfo),
  mcpInfo: pass(IPC.mcpInfo),
  obsidianPickVault: unavailable('Picking an Obsidian vault'),
  obsidianPush: pass(IPC.obsidianPush),
  uninstallSetRemoveDataOnUninstall: (value: boolean) =>
    call(IPC.uninstallSetRemoveDataOnUninstall, { value }),
  noticesOpen: pass(IPC.noticesOpen),
  templateSave: pass(IPC.templateSave),
  templateList: pass(IPC.templateList),
  templateRename: pass(IPC.templateRename),
  templateDelete: pass(IPC.templateDelete),
  templateInstantiate: pass(IPC.templateInstantiate),
  onChange: (cb: (e: unknown) => void) => {
    changeListeners.add(cb)
    return () => changeListeners.delete(cb)
  },
  onTrayOpenBoard: () => () => {}
}
