// Platform-agnostic surface + the HTTP (desktop) bridge. The wasm/wa-sqlite bridge
// (web-only, ~1MB) lives behind the "@companion/core-bridge/wasm" subpath so shells
// that don't need it (desktop) never bundle it.
export type {
  CoreBridge,
  SqliteDriver,
  SqlValue,
  Note,
  Task,
  TaskReminder,
  Document,
  TaskStatus,
  TaskNotification,
  NotificationFeedItem,
  RepeatingTask,
  RepeatPreview,
  Area,
  Project,
  ProjectMember,
  SidebarData,
  SidebarArea,
  SidebarProject,
  List,
  ListItem,
  ListItemKind,
  TrashItem,
  TrashEntityType,
  ObjectProps,
  ObjectType,
  ObjectSchema,
  ObjectField,
  ObjectFieldType,
  AppliesTo,
  CalendarFeed,
  CalendarFeedKind,
  CalendarAccount,
  CalendarConflict,
  CalendarEvent,
  CalendarItem,
  CalendarItemKind,
  Canvas,
  CanvasNode,
  CanvasEdge,
  CanvasNodeKind,
  CanvasRefType,
  CanvasSide,
  CanvasEnd,
  CanvasEdgeStyle,
  CanvasView,
  CanvasRefs,
  CanvasDocument,
  LinkPreview,
  NoteInk,
} from "./types";
export { notesApi } from "./notes";
export type { NotesApi, CreateNoteInput, UpdateNoteInput, NoteConflict, NoteConflictAction } from "./notes";
export { tasksApi } from "./tasks";
export type { TasksApi, CreateTaskInput, UpdateTaskInput } from "./tasks";
export { importsApi } from "./imports";
export type {
  ImportsApi,
  ImportSource,
  ImportCounts,
  ImportProgress,
  ThingsAreaOutline,
  ThingsPreview,
  ThingsProjectOutline,
  ThingsSelection,
  ThingsSummary,
} from "./imports";
export { calendarApi } from "./calendar";
export { oauthApi } from "./oauth";
export type { OAuthApi, OAuthBeginResult, OAuthDone, OAuthProviderId, OAuthPurpose } from "./oauth";
export type {
  CalendarApi,
  CreateFeedInput,
  UpdateFeedInput,
  AddCalendarAccountInput,
  CalendarRepeat,
  CreateEventInput,
  UpdateEventInput,
} from "./calendar";
export { documentsApi } from "./documents";
export type { DocumentsApi, CreateDocumentInput, EnsureLocalResult, LocalPathResult, DataUrlResult } from "./documents";
export { notifyApi } from "./notify";
export type { NotifyApi } from "./notify";
export { datesApi } from "./dates";
export type { DatesApi, ParsedDate } from "./dates";
export { trashApi } from "./trash";
export type { TrashApi } from "./trash";
export { dataApi } from "./data";
export type { DataApi, DataKind, DataSummary } from "./data";
export { objectTypesApi } from "./objecttypes";
export type { ObjectTypesApi, CreateObjectTypeInput, UpdateObjectTypeInput } from "./objecttypes";
export { projectsApi } from "./projects";
export type {
  ProjectsApi,
  MemberEntityType,
  AreaMemberEntityType,
  PageFields,
  CreateAreaInput,
  UpdateAreaInput,
  CreateProjectInput,
  UpdateProjectInput,
} from "./projects";
export { listsApi } from "./lists";
export type { ListsApi, CreateListInput, UpdateListInput, ListDetail, CreatedListTask } from "./lists";
export { canvasesApi } from "./canvases";
export type { CanvasesApi, CreateCanvasInput, UpdateCanvasInput, CanvasNodeInput, CanvasEdgeInput } from "./canvases";
export { noteInkApi } from "./noteInk";
export type { NoteInkApi, NoteInkInput } from "./noteInk";
export { exportsApi, importFilesApi, EXPORT_CHANGED_EVENT, SYNC_REQUESTED_EVENT } from "./exports";
export type {
  ExportsApi,
  ExportKind as ScheduledExportKind,
  ExportSchedule,
  ExportDestination,
  ExportFolderConfig,
  ExportGitConfig,
  ExportSummary,
  ExportCapabilities,
  SaveExportInput,
  GitProvider,
  GitAuth,
  PendingSshKey,
  ImportFilesApi,
  FileImportReport,
  FileImportOutcome,
} from "./exports";
export { onboardingApi, ONBOARDING_CHANGED_EVENT } from "./onboarding";
export type { OnboardingApi, OnboardingRecord, OnboardingEntry, OnboardingOutcome } from "./onboarding";
export { pomodoroApi, pomodoroRemainingMs, POMODORO_CHANGED_EVENT } from "./pomodoro";
export type { PomodoroApi, Pomodoro, PomodoroState, PomodoroOutcome } from "./pomodoro";
export { syncApi } from "./sync";
export type { SyncApi } from "./sync";
export { graphApi } from "./graph";
export type { GraphApi, Graph, GraphNode, GraphEdge } from "./graph";
export { chatsApi } from "./chats";
export type { ChatsApi, Chat, ChatDetail, StoredChatMessage, ChatChangedEvent, ChatWorkingEvent } from "./chats";
export { aiApi } from "./ai";
export type {
  AiApi,
  AiTask,
  AiStatus,
  AiRunInput,
  AiGrammarIssue,
  AiGrammarResult,
  AiMetadataResult,
  AiDeltaEvent,
  AiDoneEvent,
  AiErrorEvent,
} from "./ai";
export { llmApi } from "./llm";
export type { LlmApi, ChatMessage, ToolCall, ToolResult, LLMTokenEvent, LLMToolEvent, LLMErrorEvent } from "./llm";
export { agentsApi, runtimeLabel, isCliRuntime, isCloudRuntime, CLI_RUNTIMES, CLOUD_RUNTIMES } from "./agents";
export type { AgentsApi, Agent, AgentRuntime, DiscoveredAgent, InstallAgentInput, UpdateAgentInput } from "./agents";
export { devicesApi } from "./devices";
export type { DevicesApi, Device, DevicePresenceEvent } from "./devices";
export { createSyncNotifier } from "./notifier";
export type { SyncNotifier } from "./notifier";
export { createNativeSyncNotifier } from "./notifier.native";
export type {
  NativeSyncNotifierDeps,
  RNEventSource,
  RNEventSourceCtor,
  RNAppState,
  RNAppStateSubscription,
} from "./notifier.native";
export * as auth from "./auth";
export type { AuthResult, PreloginResult, ResetInfo } from "./auth";
export { cryptoApi, formatRecoveryCode } from "./crypto";
export type { CryptoApi, CryptoSetup, CryptoRewrap, KdfParams } from "./crypto";
export * as keys from "./keys";
export type { KeyMaterial } from "./keys";
export { createHttpBridge } from "./http";
export type { HttpBridgeOptions } from "./http";
