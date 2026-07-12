import posthog from "posthog-js";
import type { Account, RuntimeConfig } from "../api";

// Analytics config, ported from apps/website/src/config/posthog.ts. The cloud portal is
// a browser (Vite) app rather than Expo, so this uses posthog-js. Unlike the website, the
// token/host are NOT baked into the build via env vars — they're injected at runtime by
// the Go server (GET /api/v1/config, from POSTHOG_PROJECT_TOKEN / POSTHOG_HOST), so the
// same embedded assets work across environments. initPostHog runs once the config is
// fetched. Same behavior otherwise: disabled unless a real token is set, exception
// autocapture on, and every captured $exception tagged with the originating app.

let enabled = false;

/** Initialize posthog-js from the server's runtime config. No-op if already initialized
 * or no token is configured (analytics stays disabled). */
export function initPostHog(cfg: Pick<RuntimeConfig, "posthogProjectToken" | "posthogHost">): void {
  if (enabled) return;

  const token = cfg.posthogProjectToken?.trim();
  const host = cfg.posthogHost?.trim() || "https://us.i.posthog.com";
  if (!token || token === "phc_your_project_token_here") {
    // Operator hasn't set POSTHOG_PROJECT_TOKEN — leave analytics disabled.
    return;
  }

  posthog.init(token, {
    api_host: host,
    // Pageviews are captured manually on route change (the portal is an SPA with a
    // custom history router); see useAnalytics.
    capture_pageview: false,
    // Uncaught exceptions + unhandled promise rejections.
    capture_exceptions: true,
    before_send: (event) => {
      if (event && event.event === "$exception") {
        const exceptionList = (event.properties?.["$exception_list"] as unknown[]) || [];
        const exception = exceptionList.length > 0 ? exceptionList[0] : null;

        if (exception) {
          if (!event.properties) event.properties = {};
          event.properties["app"] = "cloud";
        }
      }

      return event;
    },
  });
  enabled = true;
}

export function isPostHogEnabled(): boolean {
  return enabled;
}

/** Associate the current (and future) events with the signed-in account. Safe to call
 * repeatedly — PostHog updates the person's properties each time. No-op if disabled. */
export function identifyUser(account: Account): void {
  if (!enabled) return;
  const name = [account.firstName, account.lastName].filter(Boolean).join(" ").trim();
  posthog.identify(account.userId, {
    email: account.email,
    ...(name ? { name } : {}),
    email_verified: account.emailVerified,
    encrypted: account.encrypted,
  });
}

/** Clear the identified user on sign-out so subsequent events aren't attributed to them.
 * No-op if disabled. */
export function resetAnalytics(): void {
  if (!enabled) return;
  posthog.reset();
}

export { posthog };
