// Forgot-password recovery deep link (PLAN §E2EE). The reset email opens the app with the reset
// token and the account's API base URL as query params; the app then runs the recovery flow using
// its local crypto core. Web/desktop read it from the URL here; native shells parse the deep link
// and render RecoveryResetScreen themselves.

export type ResetLink = { token: string; baseUrl: string };

// React Native defines a `window` global without `location`; feature-detect the real API.
function browserLocation(): Location | null {
  return typeof window !== "undefined" && window.location ? window.location : null;
}

/** The reset link the current URL requests (`?resetToken=…&server=…`), or null. The server param
 *  carries the API base so a not-yet-signed-in app knows where to send the reset. */
export function resetLinkTarget(): ResetLink | null {
  const loc = browserLocation();
  if (!loc) return null;
  const params = new URLSearchParams(loc.search);
  const token = params.get("resetToken");
  const server = params.get("server");
  if (token && server) return { token, baseUrl: server };
  return null;
}

/** Leave the reset flow: strip the query params and return to the normal app. */
export function clearResetLink(): void {
  const loc = browserLocation();
  if (!loc) return;
  window.location.href = loc.pathname;
}

/** Parse a reset link (or bare token) a user pastes into the app's "Forgot password" flow. Accepts
 *  the app deep link (…?resetToken=…&server=…), the portal link (…/reset?token=…), or a raw token.
 *  `baseUrl` is returned only when the link carried a server; otherwise the caller supplies it (the
 *  server the user is signing in against). */
export function parseResetLink(input: string): { token: string; baseUrl?: string } | null {
  const s = input.trim();
  if (!s) return null;
  const q = s.indexOf("?");
  if (q >= 0) {
    const params = new URLSearchParams(s.slice(q + 1));
    const rt = params.get("resetToken");
    if (rt) return { token: rt, baseUrl: params.get("server") ?? undefined };
    const t = params.get("token");
    if (t) return { token: t };
  }
  // A bare token from the email (long hex).
  if (/^[a-f0-9]{16,}$/i.test(s)) return { token: s };
  return null;
}
