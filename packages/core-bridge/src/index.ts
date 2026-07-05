// Platform-agnostic surface + the HTTP (desktop) bridge. The wasm/wa-sqlite bridge
// (web-only, ~1MB) lives behind the "@companion/core-bridge/wasm" subpath so shells
// that don't need it (desktop) never bundle it.
export type {
  CoreBridge,
  SqliteDriver,
  SqlValue,
  Note,
  Area,
  Project,
  ProjectMember,
  SidebarData,
  SidebarArea,
  SidebarProject,
  TrashItem,
  TrashEntityType,
} from "./types";
export { notesApi } from "./notes";
export type { NotesApi, CreateNoteInput, UpdateNoteInput, NoteConflict, NoteConflictAction } from "./notes";
export { trashApi } from "./trash";
export type { TrashApi } from "./trash";
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
export type { AuthResult } from "./auth";
export { createHttpBridge } from "./http";
export type { HttpBridgeOptions } from "./http";
