import { Linking } from "react-native";
import { openExternalUrl } from "./externalUrl";
import type { CoreBridge, OAuthApi, OAuthDone, OAuthProviderId, OAuthPurpose } from "@companion/core-bridge";

// This repo's trimmed React Native typings declare only openURL/canOpenURL on Linking; the
// deep-link listener exists at runtime on native (and as a no-op emitter on react-native-web).
const deepLinks = Linking as unknown as {
  addEventListener(type: "url", handler: (event: { url: string }) => void): { remove(): void };
};

// The provider's page opens in the user's real browser — where they are already signed in to
// Google, with their password manager and passkeys — never an embedded webview (which Google
// blocks anyway). See externalUrl.ts for how each shell does that.
/** How long to wait for the user to come back from the browser. The core forgets a flow after
 *  ten minutes; give up a little before it does. */
const TIMEOUT_MS = 9 * 60_000;

export interface OAuthFlowHandle<T> {
  /** Resolves with the purpose's result (for "calendar", the account) or rejects with a message
   *  fit to show the user. */
  result: Promise<T>;
  /** Abandon the flow (the user closed the dialog). `result` rejects with "cancelled". */
  cancel: () => void;
}

/** Runs one OAuth sign-in: starts it in the core, opens the provider's page in the system browser,
 *  and waits for the outcome. It is not calendar-specific — `purpose` decides what the grant is
 *  used for — so a "Sign in with Google" button can call this unchanged once the core has a
 *  "login" purpose (see core/bridge/oauth.go).
 *
 *  Two last hops, chosen by the core:
 *   - desktop: the core listens on a loopback port, finishes the flow itself and emits `oauth.done`;
 *   - mobile (and later web): the provider redirects to the app's own URL, which arrives here as a
 *     deep link and is handed back to the core with `oauth.complete`.
 *  Either way the code exchange, PKCE verifier and tokens stay in the core; this only moves URLs. */
export function startOAuthFlow<T>(
  core: CoreBridge,
  oauth: OAuthApi,
  provider: OAuthProviderId,
  purpose: OAuthPurpose,
  args?: Record<string, unknown>,
): OAuthFlowHandle<T> {
  let state: string | null = null;
  let cancelled = false;
  const cleanups: (() => void)[] = [];
  const cleanup = () => cleanups.splice(0).forEach((fn) => fn());
  let rejectOuter: (e: Error) => void = () => {};

  const result = new Promise<T>((resolve, reject) => {
    rejectOuter = reject;
    const settle = (fn: () => void) => {
      cleanup();
      fn();
    };

    void (async () => {
      const begin = await oauth.begin(provider, purpose, args);
      state = begin.state;
      if (cancelled) {
        void oauth.cancel(begin.state).catch(() => undefined);
        return;
      }

      const timer = setTimeout(() => settle(() => reject(new Error("Sign-in timed out. Try again."))), TIMEOUT_MS);
      cleanups.push(() => clearTimeout(timer));

      if (begin.loopback) {
        cleanups.push(
          core.on("oauth.done", (payload) => {
            const done = payload as OAuthDone<T> | null;
            if (!done || done.state !== begin.state) return;
            settle(() => (done.ok ? resolve(done.result as T) : reject(new Error(done.error ?? "Sign-in failed."))));
          }),
        );
      } else {
        const sub = deepLinks.addEventListener("url", ({ url }: { url: string }) => {
          // Only the redirect of THIS flow: other deep links (password reset, …) pass through.
          if (!url.includes(`state=${encodeURIComponent(begin.state)}`)) return;
          oauth
            .complete<T>(url)
            .then((res) => settle(() => resolve(res.result)))
            .catch((e) => settle(() => reject(e instanceof Error ? e : new Error(String(e)))));
        });
        cleanups.push(() => sub.remove());
      }

      await openExternalUrl(begin.authUrl);
    })().catch((e) => settle(() => reject(e instanceof Error ? e : new Error(String(e)))));
  });

  return {
    result,
    cancel: () => {
      cancelled = true;
      cleanup();
      if (state) void oauth.cancel(state).catch(() => undefined);
      rejectOuter(new Error("cancelled"));
    },
  };
}
