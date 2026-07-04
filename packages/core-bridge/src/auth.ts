// Auth against the sync server (register/login -> bearer token). Runs in the shell
// (web/desktop) over fetch; the token is then handed to sync.configure. Kept out of
// the wasm/native core so credentials never cross the bridge.

export interface AuthResult {
  token: string;
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

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
