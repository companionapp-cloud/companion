import { useEffect, useRef, useState } from "react";
import * as api from "./api";
import { identifyUser, initPostHog, isPostHogEnabled, posthog } from "./config/posthog";
import { usePath } from "./router";

// Analytics bootstrap for the portal. Fetches the server's runtime config (which carries
// the PostHog token/host injected from the Go process env), initializes posthog-js once,
// captures an SPA pageview on every path change — mirroring the website's screen tracking
// (apps/website/app/_layout.tsx) — and identifies the signed-in account when one is present.
export function useAnalytics(account: api.Account | null) {
  const path = usePath();
  const [ready, setReady] = useState(false);
  const previousPath = useRef<string | undefined>(undefined);

  // Fetch runtime config and initialize PostHog once. If the token isn't configured (or
  // the config request fails, e.g. the API is down), analytics simply stays disabled.
  useEffect(() => {
    let cancelled = false;
    api
      .getConfig()
      .then((cfg) => {
        if (cancelled) return;
        initPostHog(cfg);
        setReady(isPostHogEnabled());
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Once PostHog is ready, capture the current page and each subsequent navigation.
  useEffect(() => {
    if (!ready) return;
    if (previousPath.current !== path) {
      posthog.capture("$pageview", {
        $current_url: window.location.href,
        previous_pathname: previousPath.current ?? null,
      });
      previousPath.current = path;
    }
  }, [ready, path]);

  // Identify the signed-in account (sign-out calls resetAnalytics from App's handler).
  useEffect(() => {
    if (!ready || !account) return;
    identifyUser(account);
  }, [ready, account]);
}
