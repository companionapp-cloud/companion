// Auth against the sync server (register/login -> bearer token). Runs in the shell
// (web/desktop) over fetch; the token is then handed to sync.configure. Kept out of
// the wasm/native core so credentials never cross the bridge.

export interface AuthResult {
  token: string;
  /** Long-lived token used to mint a new access token without re-entering credentials. */
  refreshToken: string;
  /** RFC3339 timestamp at which `token` expires. */
  expiresAt: string;
  userId: string;
}

async function authFetch(baseUrl: string, path: "login" | "register", email: string, password: string): Promise<AuthResult> {
  const res = await fetch(`${trimSlash(baseUrl)}/v1/auth/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `${path} failed (${res.status})`);
  }
  return data as AuthResult;
}

export function login(baseUrl: string, email: string, password: string): Promise<AuthResult> {
  return authFetch(baseUrl, "login", email, password);
}

export function register(baseUrl: string, email: string, password: string): Promise<AuthResult> {
  return authFetch(baseUrl, "register", email, password);
}

/** Result of the pre-login lookup (PLAN §E2EE). For an encryption-enabled account it carries the
 *  KDF salt + params so the client can derive its auth key before authenticating; for a plaintext
 *  or unknown account, `encrypted` is false and the client logs in with the raw password. */
export interface PreloginResult {
  encrypted: boolean;
  salt?: string;
  kdf?: { time: number; memoryK: number; threads: number };
}

/** Ask the server how to form the login credential for an email, before authenticating. */
export async function prelogin(baseUrl: string, email: string): Promise<PreloginResult> {
  const res = await fetch(`${trimSlash(baseUrl)}/v1/auth/prelogin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `prelogin failed (${res.status})`);
  }
  return data as PreloginResult;
}

/** Exchange a refresh token for a fresh access token. The server rotates the
 * refresh token, so the returned `refreshToken` replaces the one passed in. */
export async function refresh(baseUrl: string, refreshToken: string): Promise<AuthResult> {
  const res = await fetch(`${trimSlash(baseUrl)}/v1/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `refresh failed (${res.status})`);
  }
  return data as AuthResult;
}

/** Change the account credential, returning a fresh session (the server revokes the old one). For
 *  an encrypted account the caller passes the rewrapped `keyMaterial`, which the server stores in
 *  the SAME transaction as the credential swap — so the login credential and the wrapped master key
 *  can never drift apart and lock the user out (PLAN §E2EE). Omitting it for an encrypted account
 *  is rejected server-side; it is also omitted for a plain (non-encrypted) password change. This
 *  same call carries the first key material during the enable-encryption migration. */
export async function changePassword(
  baseUrl: string,
  token: string,
  currentCredential: string,
  newCredential: string,
  keyMaterial?: unknown,
): Promise<AuthResult> {
  const res = await fetch(`${trimSlash(baseUrl)}/v1/account/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ currentPassword: currentCredential, newPassword: newCredential, keyMaterial }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `password change failed (${res.status})`);
  }
  return data as AuthResult;
}

/** Request a password-reset email for an address (cloud-only; open-core servers may 404). Always
 *  resolves the same way regardless of whether the address exists (the server doesn't reveal it). */
export async function forgotPassword(baseUrl: string, email: string): Promise<void> {
  const res = await fetch(`${trimSlash(baseUrl)}/v1/auth/forgot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error || `couldn't send reset email (${res.status})`);
  }
}

/** Result of the pre-auth reset lookup the app does on a reset deep link (PLAN §E2EE): whether the
 *  account is encrypted and, if so, its recovery-wrapped key blob (needed to recover with the
 *  recovery code). The emailed reset token authorizes the lookup. */
export interface ResetInfo {
  encrypted: boolean;
  recoveryWrapped?: string;
}

export async function resetInfo(baseUrl: string, token: string): Promise<ResetInfo> {
  const res = await fetch(`${trimSlash(baseUrl)}/v1/auth/reset/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `reset lookup failed (${res.status})`);
  return data as ResetInfo;
}

/** Consume a reset token and set a new password. For an encrypted account, keyMaterial is the
 *  master key rewrapped under the new password (via the recovery code) — the server stores it with
 *  the new credential atomically. Omitted for a plaintext account. */
export async function resetPassword(baseUrl: string, token: string, newPassword: string, keyMaterial?: unknown): Promise<void> {
  const res = await fetch(`${trimSlash(baseUrl)}/v1/auth/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, newPassword, keyMaterial }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error || `reset failed (${res.status})`);
  }
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
