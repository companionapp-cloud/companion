// Platform-agnostic surface + the HTTP (desktop) bridge. The wasm/wa-sqlite bridge
// (web-only, ~1MB) lives behind the "@companion/core-bridge/wasm" subpath so shells
// that don't need it (desktop) never bundle it.
export type {
  CoreBridge,
  SqliteDriver,
  SqlValue,
  Note,
  Task,
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
  TrashItem,
  TrashEntityType,
  ObjectProps,
  ObjectType,
  ObjectSchema,
  ObjectField,
  ObjectFieldType,
  AppliesTo,
  CalendarFeed,
  CalendarEvent,
  CalendarItem,
  CalendarItemKind,
} from "./types";
export { notesApi } from "./notes";
export type { NotesApi, CreateNoteInput, UpdateNoteInput, NoteConflict, NoteConflictAction } from "./notes";
export { tasksApi } from "./tasks";
export type { TasksApi, CreateTaskInput, UpdateTaskInput } from "./tasks";
export { calendarApi } from "./calendar";
export type { CalendarApi, CreateFeedInput, UpdateFeedInput } from "./calendar";
export { documentsApi } from "./documents";
export type { DocumentsApi, CreateDocumentInput, EnsureLocalResult, LocalPathResult, DataUrlResult } from "./documents";
export { notifyApi } from "./notify";
export type { NotifyApi } from "./notify";
export { datesApi } from "./dates";
export type { DatesApi, ParsedDate } from "./dates";
export { trashApi } from "./trash";
export type { TrashApi } from "./trash";
export { objectTypesApi } from "./objecttypes";
export type { ObjectTypesApi, CreateObjectTypeInput, UpdateObjectTypeInput } from "./objecttypes";
export { projectsApi } from "./projects";
export type {
  ProjectsApi,
  MemberEntityType,
  CreateAreaInput,
  UpdateAreaInput,
  CreateProjectInput,
  UpdateProjectInput,
} from "./projects";
export { syncApi } from "./sync";
export type { SyncApi } from "./sync";
export { graphApi } from "./graph";
export type { GraphApi, Graph, GraphNode, GraphEdge } from "./graph";
export { chatsApi } from "./chats";
export type { ChatsApi, Chat, ChatDetail, StoredChatMessage, ChatChangedEvent, ChatWorkingEvent } from "./chats";
export { llmApi } from "./llm";
export type {
  LlmApi,
  LLMConfig,
  LLMScope,
  LLMProvider,
  CreateLLMConfigInput,
  UpdateLLMConfigInput,
  ChatMessage,
  ToolCall,
  ToolResult,
  LLMTokenEvent,
  LLMToolEvent,
  LLMErrorEvent,
} from "./llm";
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
