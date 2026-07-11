// Server-facing HTTP for the wrapped encryption key blob (PLAN §E2EE). The server is a blind
// custodian: it stores and returns ciphertext + derivation params, nothing it can read. These are
// plain fetch calls (like ./auth), kept out of the core so the flow stays in the shell.

import type { KdfParams } from "./crypto";

/** The wrapped key material an account stores server-side. Every field is ciphertext or public
 *  derivation metadata. */
export interface KeyMaterial {
  wrappedMasterKey: string;
  kdfSalt: string;
  kdfTime: number;
  kdfMemoryK: number;
  kdfThreads: number;
  recoveryWrapped?: string;
  publicKey?: string;
}

/** Fetch the account's key material, or null when the account has no encryption set up (404). */
export async function fetchKeys(baseUrl: string, token: string): Promise<KeyMaterial | null> {
  const res = await fetch(`${trimSlash(baseUrl)}/v1/keys`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `fetch keys failed (${res.status})`);
  return data as KeyMaterial;
}

/** Store (or replace) the account's wrapped key material. Replacement is how a password change
 *  re-wraps the same master key without re-encrypting any content. */
export async function putKeys(baseUrl: string, token: string, material: KeyMaterial): Promise<void> {
  const res = await fetch(`${trimSlash(baseUrl)}/v1/keys`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(material),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error || `put keys failed (${res.status})`);
  }
}

/** Build the server KeyMaterial from a crypto.setup/rewrap result. */
export function materialFromSetup(s: { wrappedMasterKey: string; salt: string; kdf: KdfParams; recoveryWrapped?: string }): KeyMaterial {
  return {
    wrappedMasterKey: s.wrappedMasterKey,
    kdfSalt: s.salt,
    kdfTime: s.kdf.time,
    kdfMemoryK: s.kdf.memoryK,
    kdfThreads: s.kdf.threads,
    recoveryWrapped: s.recoveryWrapped,
  };
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
