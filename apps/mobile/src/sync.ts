import { auth, syncApi, cryptoApi, type CoreBridge } from '@companion/core-bridge';
import { nativeSyncStorage } from './syncStorage';

// A headless, one-shot sync for the background reminder task. SyncProvider owns the rich
// foreground loop (debounce, idle timer, realtime SSE); the background task only needs a
// single catch-up pull so reminders created on other devices land in the local DB before we
// reschedule. It reads the same persisted config SyncProvider writes and refreshes the
// access token the same way, so it stays compatible with the foreground session.

const REFRESH_SKEW_MS = 60 * 1000; // refresh a bit before expiry to avoid races

interface PersistedConfig {
  baseUrl: string;
  token: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  email: string;
}

/** Run one sync cycle if the device is signed in; no-op otherwise. Best-effort — any
 *  failure (offline, expired session) is swallowed so the caller can still schedule from
 *  whatever is already in the local DB. */
export async function syncOnce(core: CoreBridge): Promise<void> {
  const raw = nativeSyncStorage.load();
  if (!raw) return; // not signed in
  let cfg: PersistedConfig;
  try {
    cfg = JSON.parse(raw) as PersistedConfig;
  } catch {
    return;
  }
  const api = syncApi(core);

  // For an encrypted account, restore the master key from the keychain before syncing so this
  // headless pass encrypts pushes and decrypts pulls just like the foreground loop. Without it a
  // pull would write ciphertext into the local store. No-op for a plaintext account (PLAN §E2EE).
  await cryptoApi(core).unlockFromCache();

  const refresh = async (): Promise<boolean> => {
    if (!cfg.refreshToken) return false;
    try {
      const res = await auth.refresh(cfg.baseUrl, cfg.refreshToken);
      cfg = { ...cfg, token: res.token, refreshToken: res.refreshToken, expiresAt: Date.parse(res.expiresAt) };
      nativeSyncStorage.save(JSON.stringify(cfg));
      return true;
    } catch {
      return false;
    }
  };

  // Proactive refresh when the access token is at/near expiry.
  if (cfg.expiresAt && Date.now() >= cfg.expiresAt - REFRESH_SKEW_MS) {
    if (!(await refresh())) return;
  }

  try {
    await api.configure(cfg.baseUrl, cfg.token);
    await api.run();
  } catch (e) {
    // Reactive fallback: one refresh + retry on an auth rejection, else give up this cycle.
    if (!isAuthError(e) || !(await refresh())) return;
    try {
      await api.configure(cfg.baseUrl, cfg.token);
      await api.run();
    } catch {
      /* give up until the next scheduled run */
    }
  }
}

function isAuthError(e: unknown): boolean {
  return /\b401\b/.test(e instanceof Error ? e.message : String(e));
}
