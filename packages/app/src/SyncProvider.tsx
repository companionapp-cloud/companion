import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { auth, keys, cryptoApi, formatRecoveryCode, syncApi, createSyncNotifier, type SyncApi, type SyncNotifier } from "@companion/core-bridge";
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
  /** The account is end-to-end encrypted (PLAN §E2EE): the master key must be unlocked before
   *  syncing, or a push would leak plaintext. New accounts register encrypted by default. */
  encrypted: boolean;
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

// "locked": an encrypted account whose master key isn't in memory (e.g. a web reload, where the
// key isn't cached). Sync is paused until unlock() re-derives it from the password, so a locked
// store can never push plaintext (PLAN §E2EE).
export type SyncStatus = "disconnected" | "idle" | "syncing" | "error" | "locked";
export type AuthMode = "login" | "register";

/** connect returns the one-time recovery code when a new encrypted account was created, so the UI
 *  can show it once and tell the user to store it — losing both password and code means losing the
 *  data (the server holds only ciphertext). */
export interface ConnectResult {
  recoveryCode: string | null;
}

export interface SyncController {
  connected: boolean;
  email: string | null;
  status: SyncStatus;
  /** The connected account is end-to-end encrypted. */
  encrypted: boolean;
  lastError: string | null;
  lastSyncedAt: number | null;
  connect: (baseUrl: string, email: string, password: string, mode: AuthMode) => Promise<ConnectResult>;
  /** Re-derive the master key for a locked encrypted account, then resume syncing. */
  unlock: (password: string) => Promise<void>;
  /** Migrate a connected plaintext account to end-to-end encryption: swap the credential, upload
   *  the wrapped key, and re-push every row encrypted. Returns the one-time recovery code. */
  enableEncryption: (password: string) => Promise<ConnectResult>;
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
  const crypto = useMemo(() => cryptoApi(core), [core]);
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

  // For an encrypted account, make sure the master key is in memory before any sync. Native
  // shells restore it from the keychain (unlockFromCache); web has no keychain, so after a reload
  // the store stays locked until the user re-enters the password. Returns false when still locked —
  // the caller must NOT sync then, or it would push plaintext (PLAN §E2EE).
  const ensureUnlocked = useCallback(async (): Promise<boolean> => {
    const cfg = configRef.current;
    if (!cfg?.encrypted) return true;
    if ((await crypto.status()).unlocked) return true;
    return (await crypto.unlockFromCache()).unlocked;
  }, [crypto]);

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
      // Never sync an encrypted account whose key isn't loaded — that would leak plaintext.
      if (!(await ensureUnlocked())) {
        setStatus("locked");
        return; // finally resets `running` and schedules the next check
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

  const connect = useCallback(async (baseUrl: string, email: string, password: string, mode: AuthMode): Promise<ConnectResult> => {
    let res;
    let encrypted = false;
    let recoveryCode: string | null = null;

    if (mode === "register") {
      // New accounts are end-to-end encrypted by default (PLAN §E2EE): generate the key material
      // locally, register with the derived auth key (so the server never sees the password), then
      // upload the wrapped key. The store is left unlocked, and the recovery code is surfaced once.
      const setup = await crypto.setup(password);
      res = await auth.register(baseUrl, email, setup.authKeyHex);
      await keys.putKeys(baseUrl, res.token, keys.materialFromSetup(setup));
      encrypted = true;
      recoveryCode = formatRecoveryCode(setup.recoveryCode);
    } else {
      // Ask the server how this account authenticates before sending anything.
      const pre = await auth.prelogin(baseUrl, email);
      if (pre.encrypted && pre.salt && pre.kdf) {
        const { authKeyHex } = await crypto.deriveAuthKey(password, pre.salt, pre.kdf);
        res = await auth.login(baseUrl, email, authKeyHex);
        const km = await keys.fetchKeys(baseUrl, res.token);
        if (km) {
          await crypto.unlock(password, km.wrappedMasterKey, km.kdfSalt, {
            time: km.kdfTime,
            memoryK: km.kdfMemoryK,
            threads: km.kdfThreads,
          });
          encrypted = true;
        }
      } else {
        // Legacy plaintext account: authenticate with the raw password, no encryption.
        res = await auth.login(baseUrl, email, password);
      }
    }

    const cfg: PersistedConfig = {
      baseUrl,
      token: res.token,
      refreshToken: res.refreshToken,
      expiresAt: Date.parse(res.expiresAt),
      email,
      encrypted,
    };
    saveConfig(cfg, storageRef.current);
    setStatus("idle");
    setLastError(null);
    setConfig(cfg); // effect re-configures + syncs
    return { recoveryCode };
  }, [crypto]);

  // unlock re-derives the master key for a locked encrypted account (a web reload, typically),
  // then resumes syncing. Wrong password surfaces as an error and leaves the store locked.
  const unlock = useCallback(async (password: string) => {
    const cfg = configRef.current;
    if (!cfg) throw new Error("not connected");
    const km = await keys.fetchKeys(cfg.baseUrl, cfg.token);
    if (!km) throw new Error("this account has no encryption key");
    await crypto.unlock(password, km.wrappedMasterKey, km.kdfSalt, {
      time: km.kdfTime,
      memoryK: km.kdfMemoryK,
      threads: km.kdfThreads,
    });
    setStatus("idle");
    setLastError(null);
    void runNow();
  }, [crypto, runNow]);

  // enableEncryption migrates a connected plaintext account (PLAN §E2EE). It generates key material,
  // swaps the server credential from the raw password to the derived auth key (via the account
  // password-change endpoint, which rotates the session), uploads the wrapped key, then flags every
  // row dirty and syncs so the server's plaintext copies are overwritten with ciphertext.
  const enableEncryption = useCallback(async (password: string): Promise<ConnectResult> => {
    const cfg = configRef.current;
    if (!cfg) throw new Error("not connected");
    if (cfg.encrypted) return { recoveryCode: null };

    const setup = await crypto.setup(password); // generates + unlocks the master key
    const session = await auth.changePassword(cfg.baseUrl, cfg.token, password, setup.authKeyHex);
    const next: PersistedConfig = {
      ...cfg,
      token: session.token,
      refreshToken: session.refreshToken,
      expiresAt: Date.parse(session.expiresAt),
      encrypted: true,
    };
    configRef.current = next;
    saveConfig(next, storageRef.current);
    await keys.putKeys(next.baseUrl, next.token, keys.materialFromSetup(setup));
    await crypto.reencryptAll(); // flag every row dirty
    setConfig(next); // reconfigures with the rotated token + syncs (re-pushes encrypted)
    void runNow();
    return { recoveryCode: formatRecoveryCode(setup.recoveryCode) };
  }, [crypto, runNow]);

  const disconnect = useCallback(() => {
    // Drop the in-memory master key (and native cache) so signing out also locks the store.
    void crypto.lock();
    clearConfig(storageRef.current);
    setConfig(null);
    setStatus("disconnected");
    setLastError(null);
    setLastSyncedAt(null);
  }, [crypto]);

  const value = useMemo<SyncController>(
    () => ({
      connected: !!config,
      email: config?.email ?? null,
      status,
      encrypted: config?.encrypted ?? false,
      lastError,
      lastSyncedAt,
      connect,
      unlock,
      enableEncryption,
      disconnect,
      trigger,
    }),
    [config, status, lastError, lastSyncedAt, connect, unlock, enableEncryption, disconnect, trigger],
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
