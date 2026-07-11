import type { CoreBridge } from "./types";

// End-to-end encryption control surface (PLAN §E2EE). The key derivation, wrapping, and the
// in-memory master key all live in the Go core (so key material never lives in JS); these are the
// typed wrappers the shell drives it through. The server-facing HTTP for the wrapped key blob
// (GET/PUT /v1/keys) and the pre-login salt lookup live in ./keys and ./auth, since they are plain
// fetch calls, not core methods.

/** Argon2id cost parameters, stored (unencrypted) beside the wrapped key so any device can
 *  reproduce the derivation. */
export interface KdfParams {
  time: number;
  memoryK: number;
  threads: number;
}

/** What crypto.setup returns: everything the shell must persist to the server, plus the one-time
 *  recovery code to show the user. `authKeyHex` replaces the password as the login credential. */
export interface CryptoSetup {
  authKeyHex: string;
  salt: string;
  kdf: KdfParams;
  wrappedMasterKey: string;
  recoveryWrapped: string;
  recoveryCode: string;
}

/** What crypto.rewrap returns on a password change: a fresh credential + wrapped blob (the
 *  recovery-wrapped copy is unchanged, so it is not returned). */
export interface CryptoRewrap {
  authKeyHex: string;
  salt: string;
  kdf: KdfParams;
  wrappedMasterKey: string;
}

export function cryptoApi(core: CoreBridge) {
  return {
    /** Provision encryption for the first time; leaves the store unlocked. Returns the material
     *  to upload plus the recovery code to display once. */
    setup: (password: string) => core.invoke<CryptoSetup>("crypto.setup", { password }),

    /** Derive the server-facing auth key from a password + the account's stored salt/params, so
     *  login can authenticate without the server seeing the password. */
    deriveAuthKey: (password: string, salt: string, kdf: KdfParams) =>
      core.invoke<{ authKeyHex: string }>("crypto.deriveAuthKey", { password, salt, kdf }),

    /** Unwrap the master key with the password and hold it in memory (also caches it natively). */
    unlock: (password: string, wrappedMasterKey: string, salt: string, kdf: KdfParams) =>
      core.invoke<{ unlocked: boolean }>("crypto.unlock", { password, wrappedMasterKey, salt, kdf }),

    /** Unlock via the recovery code (forgotten-password escape hatch). */
    unlockWithRecovery: (recoveryCode: string, recoveryWrapped: string) =>
      core.invoke<{ unlocked: boolean }>("crypto.unlockWithRecovery", { recoveryCode, recoveryWrapped }),

    /** Re-wrap the (unlocked) master key under a new password for a password change. */
    rewrap: (newPassword: string) => core.invoke<CryptoRewrap>("crypto.rewrap", { newPassword }),

    /** Restore the master key from the platform keychain without a password (native only). */
    unlockFromCache: () => core.invoke<{ unlocked: boolean }>("crypto.unlockFromCache"),

    /** Drop the in-memory key and clear the cache. */
    lock: () => core.invoke<{ ok: boolean }>("crypto.lock"),

    /** Whether the store is currently unlocked. */
    status: () => core.invoke<{ unlocked: boolean }>("crypto.status"),

    /** Flag every content row dirty so the next sync re-pushes it encrypted — the local half of
     *  migrating an existing plaintext account (requires the store to be unlocked). */
    reencryptAll: () => core.invoke<{ marked: number }>("crypto.reencryptAll"),
  };
}

export type CryptoApi = ReturnType<typeof cryptoApi>;

/** Formats a recovery code for display: grouped in fours, hyphen-separated. The Go core's
 *  NormalizeRecoveryCode reverses this when the user types it back. */
export function formatRecoveryCode(code: string): string {
  return (code.match(/.{1,4}/g) ?? [code]).join("-");
}
