// Platform-agnostic surface + the HTTP (desktop) bridge. The wasm/wa-sqlite bridge
// (web-only, ~1MB) lives behind the "@companion/core-bridge/wasm" subpath so shells
// that don't need it (desktop) never bundle it.
export type { CoreBridge, SqliteDriver, SqlValue, Note } from "./types";
export { notesApi } from "./notes";
export type { NotesApi, CreateNoteInput, UpdateNoteInput } from "./notes";
export { syncApi } from "./sync";
export type { SyncApi } from "./sync";
export { graphApi } from "./graph";
export type { GraphApi, Graph, GraphNode, GraphEdge } from "./graph";
export * as auth from "./auth";
export type { AuthResult } from "./auth";
export { createHttpBridge } from "./http";
export type { HttpBridgeOptions } from "./http";
