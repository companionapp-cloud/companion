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

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
