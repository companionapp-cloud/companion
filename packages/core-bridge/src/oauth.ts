import type { CoreBridge } from "./types";

/** OAuth providers the core knows. */
export type OAuthProviderId = "google";

/** What a grant is for. "calendar" connects a calendar account; a future "login" purpose (sign in
 *  to Companion) plugs into the same flow without changing this API. */
export type OAuthPurpose = "calendar";

export interface OAuthBeginResult {
  /** Identifies the flow in `complete`, `cancel` and the `oauth.done` event. */
  state: string;
  /** Open this in the user's browser. */
  authUrl: string;
  /** True when the core is listening on a loopback port (desktop): the flow finishes by itself
   *  and reports through the `oauth.done` event. False when the provider redirects to a custom
   *  scheme or web URL (mobile, web): the shell receives that redirect and calls `complete`. */
  loopback: boolean;
}

/** Payload of the `oauth.done` event. `result` is whatever the purpose produces — for
 *  "calendar", the CalendarAccount. Tokens never appear here. */
export interface OAuthDone<T = unknown> {
  state: string;
  ok: boolean;
  error?: string;
  result?: T;
}

/** Typed wrappers over the oauth.* core methods (PLAN-caldav.md §9). The whole flow — PKCE, the
 *  code exchange, token storage and refresh — runs in the core; the UI only opens a URL and, on
 *  platforms without a loopback listener, passes the redirect back. */
export function oauthApi(core: CoreBridge) {
  return {
    /** Shell → core, once at startup: this build's client id for a provider. `redirectUri` is
     *  set where there is no loopback listener (mobile's custom scheme). Desktop configures
     *  itself in Go and never calls this. */
    configure: (input: { provider: OAuthProviderId; clientId: string; clientSecret?: string; redirectUri?: string }) =>
      core.invoke<{ ok: boolean }>("oauth.configure", input),
    providers: () => core.invoke<{ id: OAuthProviderId; configured: boolean }[]>("oauth.providers"),
    begin: (provider: OAuthProviderId, purpose: OAuthPurpose, args?: Record<string, unknown>) =>
      core.invoke<OAuthBeginResult>("oauth.begin", { provider, purpose, args: args ?? {} }),
    /** Finish a non-loopback flow with the redirect URL the shell received. */
    complete: <T = unknown>(url: string) => core.invoke<{ ok: boolean; result: T }>("oauth.complete", { url }),
    cancel: (state: string) => core.invoke<{ ok: boolean }>("oauth.cancel", { state }),
  };
}

export type OAuthApi = ReturnType<typeof oauthApi>;
