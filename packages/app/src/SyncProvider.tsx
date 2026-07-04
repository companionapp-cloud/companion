import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { auth, syncApi, type SyncApi } from "@companion/core-bridge";
import { useCore } from "./CoreContext";

const STORAGE_KEY = "companion.sync.config";
const IDLE_MS = 5 * 60 * 1000; // sync every 5 idle minutes
const DEBOUNCE_MS = 800; // coalesce bursts of mutations/navigation

interface PersistedConfig {
  baseUrl: string;
  token: string;
  email: string;
}

export type SyncStatus = "disconnected" | "idle" | "syncing" | "error";
export type AuthMode = "login" | "register";

export interface SyncController {
  connected: boolean;
  email: string | null;
  status: SyncStatus;
  lastError: string | null;
  lastSyncedAt: number | null;
  connect: (baseUrl: string, email: string, password: string, mode: AuthMode) => Promise<void>;
  disconnect: () => void;
  /** Debounced sync — called on mutations and navigation. */
  trigger: () => void;
}

const SyncCtx = createContext<SyncController | null>(null);

/** Owns the sync loop and its triggers: on app load, after mutations, on navigation,
 * and every 5 idle minutes (PLAN §5.4). Auth token + endpoint persist locally. */
export function SyncProvider({ children }: { children: ReactNode }) {
  const { core } = useCore();
  const api = useMemo<SyncApi>(() => syncApi(core), [core]);

  const [config, setConfig] = useState<PersistedConfig | null>(loadConfig);
  const [status, setStatus] = useState<SyncStatus>(config ? "idle" : "disconnected");
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);

  const configRef = useRef(config);
  configRef.current = config;
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const running = useRef(false);

  const scheduleIdle = useCallback((run: () => void) => {
    if (idle.current) clearTimeout(idle.current);
    idle.current = setTimeout(run, IDLE_MS);
  }, []);

  const runNow = useCallback(async () => {
    if (!configRef.current || running.current) return;
    running.current = true;
    setStatus("syncing");
    try {
      await api.run();
      setLastSyncedAt(Date.now());
      setLastError(null);
      setStatus("idle");
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    } finally {
      running.current = false;
      scheduleIdle(() => void runNow());
    }
  }, [api, scheduleIdle]);

  const trigger = useCallback(() => {
    if (!configRef.current) return;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void runNow(), DEBOUNCE_MS);
  }, [runNow]);

  // Configure the core against the saved endpoint, then sync on load / reconnect.
  useEffect(() => {
    if (!config) return;
    let cancelled = false;
    (async () => {
      try {
        await api.configure(config.baseUrl, config.token);
        if (!cancelled) void runNow();
      } catch (e) {
        if (!cancelled) {
          setLastError(e instanceof Error ? e.message : String(e));
          setStatus("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config, api, runNow]);

  useEffect(
    () => () => {
      if (debounce.current) clearTimeout(debounce.current);
      if (idle.current) clearTimeout(idle.current);
    },
    [],
  );

  const connect = useCallback(async (baseUrl: string, email: string, password: string, mode: AuthMode) => {
    const res = mode === "register" ? await auth.register(baseUrl, email, password) : await auth.login(baseUrl, email, password);
    const cfg: PersistedConfig = { baseUrl, token: res.token, email };
    saveConfig(cfg);
    setStatus("idle");
    setLastError(null);
    setConfig(cfg); // effect re-configures + syncs
  }, []);

  const disconnect = useCallback(() => {
    clearConfig();
    setConfig(null);
    setStatus("disconnected");
    setLastError(null);
    setLastSyncedAt(null);
  }, []);

  const value = useMemo<SyncController>(
    () => ({
      connected: !!config,
      email: config?.email ?? null,
      status,
      lastError,
      lastSyncedAt,
      connect,
      disconnect,
      trigger,
    }),
    [config, status, lastError, lastSyncedAt, connect, disconnect, trigger],
  );

  return <SyncCtx.Provider value={value}>{children}</SyncCtx.Provider>;
}

export function useSync(): SyncController {
  const v = useContext(SyncCtx);
  if (!v) throw new Error("useSync must be used within a SyncProvider");
  return v;
}

function loadConfig(): PersistedConfig | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PersistedConfig) : null;
  } catch {
    return null;
  }
}
function saveConfig(c: PersistedConfig) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(c));
  } catch {
    /* storage unavailable */
  }
}
function clearConfig() {
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
}
