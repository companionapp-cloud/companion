import type { CoreBridge, SqliteDriver } from "./types";

// Shapes the Go wasm core exposes/consumes (see core/cmd/wasm).
interface GoHandle {
  invoke(method: string, payloadJson: string): Promise<string>;
  close(): void;
}
/** Synchronous secret store the wasm core reads LLM API keys from (PLAN §6.8). */
interface JsSecretStore {
  get(ref: string): string | null;
  set(ref: string, value: string): void;
  delete(ref: string): void;
}
type CompanionInit = (opts: {
  sqlite: SqliteDriver;
  onEvent: (name: string, payloadJson: string) => void;
  secrets: JsSecretStore;
}) => Promise<GoHandle>;

/** localStorageSecrets keeps LLM keys in localStorage under a namespaced prefix. The browser
 *  has no OS keychain; this is the web equivalent (cleared with site data). */
function localStorageSecrets(): JsSecretStore {
  const prefix = "companion.secret.";
  const ls = (): Storage | null => {
    try {
      return typeof localStorage !== "undefined" ? localStorage : null;
    } catch {
      return null; // storage disabled (private mode / blocked)
    }
  };
  return {
    get: (ref) => ls()?.getItem(prefix + ref) ?? null,
    set: (ref, value) => ls()?.setItem(prefix + ref, value),
    delete: (ref) => ls()?.removeItem(prefix + ref),
  };
}

// wasm_exec.js (loaded via <script>) defines globalThis.Go; main() registers
// __companionInit.
interface WasmGlobals {
  Go?: new () => { importObject: WebAssembly.Imports; run(i: WebAssembly.Instance): Promise<void> };
  __companionInit?: CompanionInit;
}
const g = globalThis as unknown as WasmGlobals;

export interface WasmBridgeOptions {
  /** JS SQLite implementation injected into the Go store.Driver (e.g. wa-sqlite). */
  sqlite: SqliteDriver;
  /** URL of the compiled core (default "/core.wasm"). */
  wasmUrl?: string;
}

/**
 * createWasmBridge loads core.wasm, hands it the SQLite driver, and returns a
 * CoreBridge. Requires wasm_exec.js to have run first (it defines globalThis.Go).
 */
export async function createWasmBridge(opts: WasmBridgeOptions): Promise<CoreBridge> {
  if (typeof g.Go !== "function") {
    throw new Error("wasm_exec.js not loaded: globalThis.Go is missing");
  }
  const go = new g.Go();
  const url = opts.wasmUrl ?? "/core.wasm";
  const { instance } = await WebAssembly.instantiateStreaming(fetch(url), go.importObject);
  // main() registers __companionInit synchronously, then parks on select{}; the
  // returned promise never resolves, so we must not await it.
  void go.run(instance);
  if (typeof g.__companionInit !== "function") {
    throw new Error("core wasm did not register __companionInit");
  }

  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const onEvent = (name: string, payloadJson: string) => {
    const set = listeners.get(name);
    if (!set) return;
    let payload: unknown = null;
    try {
      payload = payloadJson ? JSON.parse(payloadJson) : null;
    } catch {
      payload = payloadJson;
    }
    for (const cb of set) cb(payload);
  };

  const handle = await g.__companionInit({ sqlite: opts.sqlite, onEvent, secrets: localStorageSecrets() });

  return {
    async invoke<T>(method: string, payload?: unknown): Promise<T> {
      const out = await handle.invoke(method, JSON.stringify(payload ?? null));
      return (out ? JSON.parse(out) : null) as T;
    },
    on(event, cb) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(cb);
      return () => {
        set!.delete(cb);
      };
    },
    close() {
      handle.close();
    },
  };
}
