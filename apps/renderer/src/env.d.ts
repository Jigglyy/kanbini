// Renderer-side type for the preload bridge. Declared locally (not
// imported from apps/desktop) to avoid an app->app coupling; the
// payload shapes come from the shared contract.
import type {
  AgendaRequest,
  ArchivedItemsView,
  GetArchivedItemsRequest,
  AgendaView,
  AppInfo,
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

export {}

declare global {
  interface Window {
    kanbini?: {
      versions: { electron: string; chrome: string }
      listBoards: () => Promise<BoardsListView>
      getBoardView: (boardId?: string) => Promise<BoardView | null>
      mutate: (m: Mutation) => Promise<MutationResult>
      mutateBatch: (ms: Mutation[]) => Promise<MutationResult[]>
      attachmentAdd: (cardId: string) => Promise<AttachmentView | null>
      attachmentPasteImage: (cardId: string) => Promise<AttachmentView | null>
      linkPreviewCreate: (
        req: LinkPreviewRequest
      ) => Promise<LinkPreviewResult>
      exportNow: () => Promise<ExportSummary>
      importFolder: () => Promise<ImportSummary | null>
      backupsList: () => Promise<BackupList>
      backupsRestore: (req: BackupRestoreRequest) => Promise<ImportSummary>
      importTrello: () => Promise<TrelloImportSummary | null>
      boardExport: (req: BoardExportRequest) => Promise<BoardExportResult | null>
      boardImport: () => Promise<BoardImportSummary | null>
      showInFolder: (req: ShowInFolderRequest) => Promise<void>
      boardSetBackgroundImage: (
        req: BoardSetBackgroundImageRequest
      ) => Promise<BoardBackground | null>
      undoStatus: () => Promise<UndoStatus>
      undoApply: (req: UndoApplyRequest) => Promise<UndoApplyResult>
      redoApply: (req: UndoApplyRequest) => Promise<UndoApplyResult>
      undoClear: () => Promise<UndoStatus>
      searchCards: (req: SearchCardsRequest) => Promise<SearchHits>
      agenda: (req: AgendaRequest) => Promise<AgendaView>
      archivedItems: (req: GetArchivedItemsRequest) => Promise<ArchivedItemsView | null>
      appInfo: () => Promise<AppInfo>
      mcpInfo: () => Promise<McpInfo>
      obsidianPickVault: () => Promise<string | null>
      obsidianPush: (req: ObsidianPushRequest) => Promise<ObsidianPushResult>
      uninstallSetRemoveDataOnUninstall: (value: boolean) => Promise<void>
      noticesOpen: () => Promise<string>
      templateSave: (req: TemplateSaveRequest) => Promise<{ id: string }>
      templateList: () => Promise<TemplateSummaryList>
      templateRename: (req: TemplateRenameRequest) => Promise<void>
      templateDelete: (req: TemplateDeleteRequest) => Promise<void>
      templateInstantiate: (
        req: TemplateInstantiateRequest
      ) => Promise<TemplateInstantiateResult>
      onChange: (cb: (e: ChangeEvent) => void) => () => void
    }
  }
}
