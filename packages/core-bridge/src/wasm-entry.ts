// Web-only bridge: the Go core compiled to wasm plus its wa-sqlite SQLite driver.
// Imported via "@companion/core-bridge/wasm" so non-web shells don't bundle it.
export { createWasmBridge } from "./wasm";
export type { WasmBridgeOptions } from "./wasm";
export { createWaSqliteDriver } from "./wa-sqlite";
export type { WaSqliteOptions } from "./wa-sqlite";
export { createOpfsBlobStore, isWebBlobStoreAvailable } from "./blobstore.web";
export type { WebBlobStore, OpfsBlobStoreOptions } from "./blobstore.web";
