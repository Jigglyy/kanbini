import type {
  AgendaRequest,
  ArchivedItemsView,
  GetArchivedItemsRequest,
  AgendaView,
  AppInfo,
  AttachmentOpenResult,
  AttachmentView,
  BoardBackground,
  BoardExportRequest,
  BoardExportResult,
  BoardImportSummary,
  BoardSetBackgroundImageRequest,
  BoardsListView,
  BoardView,
  ChangeEvent,
  ExportSummary,
  BackupList,
  BackupRestoreRequest,
  ImportSummary,
  LinkPreviewRequest,
  LinkPreviewResult,
  McpInfo,
  Mutation,
  MutationResult,
  ObsidianPushRequest,
  ObsidianPushResult,
  SearchCardsRequest,
  SearchHits,
  ShowInFolderRequest,
  TrayRecentBoardsRequest,
  WindowPrefs,
  WindowPrefsPatch,
  TemplateDeleteRequest,
  TemplateInstantiateRequest,
  TemplateInstantiateResult,
  TemplateRenameRequest,
  TemplateSaveRequest,
  TemplateSummaryList,
  TrelloImportSummary,
  UndoApplyRequest,
  UndoApplyResult,
  UndoStatus
} from '@kanbini/shared'
import { isViewChange, passesReadOnlyLock } from '@kanbini/shared'
import {
  ReadOnlyError,
  isBoardReadOnly,
  lockedScopeId,
  notifyWriteBlocked,
  readOnlyBoardIds
} from './read-only'

// Thin typed accessor over the preload bridge so components don't
// repeat the window.kanbini guard.
function bridge() {
  const b = window.kanbini
  if (!b) throw new Error('preload bridge unavailable')
  return b
}

// Read-only boards (lib/read-only.ts): the renderer reaches main through
// here, so this is the main guard (a few callers also check first). A
// refusal rejects rather than throws, so it reaches callers like a
// rejected IPC call.
function refuse(boardId: string): Promise<never> {
  notifyWriteBlocked(boardId)
  return Promise.reject(new ReadOnlyError(boardId))
}

function guarded<T>(run: () => Promise<T>, boardId?: string): Promise<T> {
  const locked =
    lockedScopeId() ?? (boardId && isBoardReadOnly(boardId) ? boardId : null)
  return locked ? refuse(locked) : run()
}

/** A board-level write naming a locked board, from anywhere (the home
 *  screen has no board on screen). Reordering arranges the home screen
 *  and duplicating reads the board into a new one; neither changes the
 *  board's name, lists, labels or cards (favouriting is a view change,
 *  let through before this runs). */
function lockedBoardTarget(ms: Mutation[]): string | null {
  for (const m of ms) {
    if (m.type === 'board.create' || m.type === 'board.move') continue
    if (m.type === 'board.duplicate' || isViewChange(m)) continue
    if (!m.type.startsWith('board.') || !('id' in m) || !m.id) continue
    if (isBoardReadOnly(m.id)) return m.id
  }
  return null
}

function guardedMutations<T>(ms: Mutation[], run: () => Promise<T>): Promise<T> {
  // Ticks and view settings pass the lock (passesReadOnlyLock), so a call
  // made only of them runs; one other write in a batch and the whole
  // batch is refused.
  if (ms.length > 0 && ms.every(passesReadOnlyLock)) return run()
  const target = lockedBoardTarget(ms)
  return target ? refuse(target) : guarded(run)
}

/** Undo / redo tell main which boards are locked: it refuses an entry
 *  that would change one (a card moved or linked across boards, an AI
 *  run spanning boards) and, with no board open, skips their own
 *  entries. The board on screen being locked is refused here first. */
function undoRequest(req: UndoApplyRequest): UndoApplyRequest {
  const locked = readOnlyBoardIds()
  return locked.length > 0 ? { ...req, lockedBoardIds: locked } : req
}

export const ipc = {
  listBoards: (): Promise<BoardsListView> => bridge().listBoards(),
  getBoardView: (boardId?: string): Promise<BoardView | null> =>
    bridge().getBoardView(boardId),
  mutate: (m: Mutation): Promise<MutationResult> =>
    guardedMutations([m], () => bridge().mutate(m)),
  /** Bulk gesture - one transaction, one undo-log group (one Ctrl+Z). */
  mutateBatch: (ms: Mutation[]): Promise<MutationResult[]> =>
    guardedMutations(ms, () => bridge().mutateBatch(ms)),
  attachmentAdd: (cardId: string): Promise<AttachmentView | null> =>
    guarded(() => bridge().attachmentAdd(cardId)),
  /** Attach the clipboard image to a card; resolves null on a non-image
   *  (text) paste. */
  attachmentPasteImage: (cardId: string): Promise<AttachmentView | null> =>
    guarded(() => bridge().attachmentPasteImage(cardId)),
  /** Files dropped onto an open card. */
  attachmentAddFiles: (cardId: string, files: File[]): Promise<AttachmentView[]> =>
    guarded(() => bridge().attachmentAddFiles(cardId, files)),
  /** Open an attachment in the OS's default app (a read: not guarded). */
  attachmentOpen: (id: string): Promise<AttachmentOpenResult> => bridge().attachmentOpen(id),
  linkPreviewCreate: (req: LinkPreviewRequest): Promise<LinkPreviewResult> =>
    guarded(() => bridge().linkPreviewCreate(req)),
  exportNow: (): Promise<ExportSummary> => bridge().exportNow(),
  importFolder: (): Promise<ImportSummary | null> => bridge().importFolder(),
  backupsList: (): Promise<BackupList> => bridge().backupsList(),
  backupsRestore: (req: BackupRestoreRequest): Promise<ImportSummary> =>
    bridge().backupsRestore(req),
  importTrello: (): Promise<TrelloImportSummary | null> =>
    bridge().importTrello(),
  boardExport: (req: BoardExportRequest): Promise<BoardExportResult | null> =>
    bridge().boardExport(req),
  boardImport: (): Promise<BoardImportSummary | null> => bridge().boardImport(),
  showInFolder: (req: ShowInFolderRequest): Promise<void> => bridge().showInFolder(req),
  windowPrefs: (): Promise<WindowPrefs> => bridge().windowPrefs(),
  setWindowPrefs: (patch: WindowPrefsPatch): Promise<WindowPrefs> =>
    bridge().setWindowPrefs(patch),
  setRecentBoards: (req: TrayRecentBoardsRequest): Promise<void> =>
    bridge().setRecentBoards(req),
  boardSetBackgroundImage: (
    req: BoardSetBackgroundImageRequest
  ): Promise<BoardBackground | null> =>
    guarded(() => bridge().boardSetBackgroundImage(req), req.boardId),
  undoStatus: (): Promise<UndoStatus> => bridge().undoStatus(),
  undoApply: (req: UndoApplyRequest = {}): Promise<UndoApplyResult> =>
    guarded(() => bridge().undoApply(undoRequest(req)), req.scopeBoardId ?? undefined),
  redoApply: (req: UndoApplyRequest = {}): Promise<UndoApplyResult> =>
    guarded(() => bridge().redoApply(undoRequest(req)), req.scopeBoardId ?? undefined),
  undoClear: (): Promise<UndoStatus> => bridge().undoClear(),
  searchCards: (req: SearchCardsRequest): Promise<SearchHits> =>
    bridge().searchCards(req),
  agenda: (req: AgendaRequest): Promise<AgendaView> => bridge().agenda(req),
  archivedItems: (req: GetArchivedItemsRequest): Promise<ArchivedItemsView | null> =>
    bridge().archivedItems(req),
  appInfo: (): Promise<AppInfo> => bridge().appInfo(),
  mcpInfo: (): Promise<McpInfo> => bridge().mcpInfo(),
  obsidianPickVault: (): Promise<string | null> => bridge().obsidianPickVault(),
  obsidianPush: (req: ObsidianPushRequest): Promise<ObsidianPushResult> =>
    bridge().obsidianPush(req),
  uninstallSetRemoveDataOnUninstall: (value: boolean): Promise<void> =>
    bridge().uninstallSetRemoveDataOnUninstall(value),
  noticesOpen: (): Promise<string> => bridge().noticesOpen(),
  templateSave: (req: TemplateSaveRequest): Promise<{ id: string }> =>
    bridge().templateSave(req),
  templateList: (): Promise<TemplateSummaryList> => bridge().templateList(),
  templateRename: (req: TemplateRenameRequest): Promise<void> =>
    bridge().templateRename(req),
  templateDelete: (req: TemplateDeleteRequest): Promise<void> =>
    bridge().templateDelete(req),
  templateInstantiate: (
    req: TemplateInstantiateRequest
  ): Promise<TemplateInstantiateResult> =>
    req.kind === 'list'
      ? guarded(() => bridge().templateInstantiate(req), req.targetBoardId)
      : bridge().templateInstantiate(req),
  onChange: (cb: (e: ChangeEvent) => void): (() => void) =>
    bridge().onChange(cb),
  onTrayOpenBoard: (cb: (boardId: string) => void): (() => void) =>
    bridge().onTrayOpenBoard(cb)
}
