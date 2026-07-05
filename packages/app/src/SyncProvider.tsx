import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { auth, syncApi, createSyncNotifier, type SyncApi, type SyncNotifier } from "@companion/core-bridge";
import { useCore } from "./CoreContext";

const STORAGE_KEY = "companion.sync.config";
const IDLE_MS = 5 * 60 * 1000; // sync every 5 idle minutes
const DEBOUNCE_MS = 800; // coalesce bursts of mutations/navigation
const REFRESH_SKEW_MS = 60 * 1000; // refresh a bit before expiry to avoid races

interface PersistedConfig {
  baseUrl: string;
  token: string;
  refreshToken: string;
  expiresAt: number; // epoch ms; when `token` expires
  email: string;
}

/** Synchronous key/value persistence for the sync config. Web/desktop use
 * localStorage (the default); mobile injects an expo-file-system-backed store,
 * since React Native has no localStorage (so config was lost on cold boot). */
export interface SyncStorage {
  load(): string | null;
  save(value: string): void;
  clear(): void;
}

const localStorageBacked: SyncStorage = {
  load: () => {
    try {
      return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  },
  save: (value) => {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, value);
    } catch {
      /* storage unavailable */
    }
  },
  clear: () => {
    try {
      globalThis.localStorage?.removeItem(STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
  },
};

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
 * and every 5 idle minutes (PLAN §5.4). Auth token + endpoint persist locally; the
 * short-lived access token is refreshed silently via the refresh token so an expired
 * session never forces a manual re-auth. */
export function SyncProvider({
  children,
  storage = localStorageBacked,
  notifier: injectedNotifier,
}: {
  children: ReactNode;
  storage?: SyncStorage;
  /** Realtime SSE poke (PLAN §7.5). Defaults to the fetch-stream notifier (web +
   * desktop); mobile injects a react-native-sse-backed one. */
  notifier?: SyncNotifier;
}) {
  const { core } = useCore();
  const api = useMemo<SyncApi>(() => syncApi(core), [core]);
  const notifier = useMemo<SyncNotifier>(() => injectedNotifier ?? createSyncNotifier(), [injectedNotifier]);

  const storageRef = useRef(storage);
  storageRef.current = storage;

  const [config, setConfig] = useState<PersistedConfig | null>(() => loadConfig(storage));
  const [status, setStatus] = useState<SyncStatus>(config ? "idle" : "disconnected");
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);

  // configRef mirrors `config`, but is also updated directly on a silent token
  // refresh (which deliberately doesn't touch React state). Sync it only when the
  // identity actually changes — never on every render — so a rotated token held in
  // the ref isn't clobbered back to the stale state value by an unrelated re-render.
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  }, [config]);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const running = useRef(false);

  const scheduleIdle = useCallback((run: () => void) => {
    if (idle.current) clearTimeout(idle.current);
    idle.current = setTimeout(run, IDLE_MS);
  }, []);

  // Persist a rotated access/refresh token without re-rendering identity: the token
  // change doesn't affect the UI (email/endpoint), and configRef feeds the next sync.
  const applyRotatedTokens = useCallback((res: { token: string; refreshToken: string; expiresAt: string }) => {
    const prev = configRef.current;
    if (!prev) return;
    const next: PersistedConfig = { ...prev, token: res.token, refreshToken: res.refreshToken, expiresAt: Date.parse(res.expiresAt) };
    configRef.current = next;
    saveConfig(next, storageRef.current);
    // Reopen the realtime stream with the fresh token so SSE survives rotation (the
    // old access token would 401 the stream once it expires).
    notifier.connect(next.baseUrl, next.token);
  }, [notifier]);

  // Refresh the access token and reconfigure the core with it. Returns false if the
  // refresh token is missing/expired/revoked (the user must sign in again).
  const refreshTokens = useCallback(async (): Promise<boolean> => {
    const cfg = configRef.current;
    if (!cfg?.refreshToken) return false;
    try {
      const res = await auth.refresh(cfg.baseUrl, cfg.refreshToken);
      applyRotatedTokens(res);
      await api.configure(cfg.baseUrl, res.token);
      return true;
    } catch {
      return false;
    }
  }, [api, applyRotatedTokens]);

  const runNow = useCallback(async () => {
    if (!configRef.current || running.current) return;
    running.current = true;
    setStatus("syncing");
    try {
      // Proactively refresh if the access token is at/near expiry (covers cold boots
      // where it expired while the app was closed).
      const cfg = configRef.current;
      if (cfg.expiresAt && Date.now() >= cfg.expiresAt - REFRESH_SKEW_MS) {
        if (!(await refreshTokens())) throw new Error("Session expired — please sign in again.");
      }
      try {
        await api.run();
      } catch (e) {
        // Reactive fallback: the server rejected the token (clock skew / revoked).
        // Try one refresh + retry before surfacing the error.
        if (!isAuthError(e) || !(await refreshTokens())) throw e;
        await api.run();
      }
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
  }, [api, refreshTokens, scheduleIdle]);

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

  // Realtime: hold an SSE stream while connected. Each server change — and every
  // (re)connect, foreground, or tab-visible transition — pokes a debounced sync
  // (PLAN §7.5). The originating device hears its own echo, but that cycle is a cheap
  // no-op (its cursor already advanced during its push). Token rotation reconnects via
  // applyRotatedTokens; here we react only to identity (connect/disconnect) changes.
  useEffect(() => {
    if (!config) return;
    const off = notifier.onChange(() => trigger());
    notifier.connect(config.baseUrl, config.token);
    return () => {
      off();
      notifier.disconnect();
    };
  }, [config, notifier, trigger]);

  useEffect(
    () => () => {
      if (debounce.current) clearTimeout(debounce.current);
      if (idle.current) clearTimeout(idle.current);
    },
    [],
  );

  const connect = useCallback(async (baseUrl: string, email: string, password: string, mode: AuthMode) => {
    const res = mode === "register" ? await auth.register(baseUrl, email, password) : await auth.login(baseUrl, email, password);
    const cfg: PersistedConfig = {
      baseUrl,
      token: res.token,
      refreshToken: res.refreshToken,
      expiresAt: Date.parse(res.expiresAt),
      email,
    };
    saveConfig(cfg, storageRef.current);
    setStatus("idle");
    setLastError(null);
    setConfig(cfg); // effect re-configures + syncs
  }, []);

  const disconnect = useCallback(() => {
    clearConfig(storageRef.current);
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

// The sync engine surfaces HTTP failures as "sync <path>: 401 Unauthorized: …";
// match the status so we only attempt a refresh on genuine auth rejections.
function isAuthError(e: unknown): boolean {
  return /\b401\b/.test(e instanceof Error ? e.message : String(e));
}

function loadConfig(storage: SyncStorage): PersistedConfig | null {
  try {
    const raw = storage.load();
    return raw ? (JSON.parse(raw) as PersistedConfig) : null;
  } catch {
    return null;
  }
}
function saveConfig(c: PersistedConfig, storage: SyncStorage) {
  storage.save(JSON.stringify(c));
}
function clearConfig(storage: SyncStorage) {
  storage.clear();
}
