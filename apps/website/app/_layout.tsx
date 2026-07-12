import { Slot, useGlobalSearchParams, usePathname } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { PostHogErrorBoundary, PostHogProvider } from "posthog-js/react";
import "../src/styles/global.css";
import { initPostHog, isPostHogEnabled, posthog } from "../src/config/posthog";

// Web-only marketing/docs site. Slot (not Stack) renders each route's markup directly
// into the document, avoiding the native-stack screen container that absolutely-positions
// content and breaks normal document scrolling.
export default function RootLayout() {
  const pathname = usePathname();
  const params = useGlobalSearchParams();
  const previousPathname = useRef<string | undefined>(undefined);
  const [ready, setReady] = useState(false);

  // Initialize posthog-js on the client once (no-op during static export in Node).
  useEffect(() => {
    initPostHog();
    setReady(isPostHogEnabled && posthog.__loaded === true);
  }, []);

  // Manual SPA pageview capture on route change.
  useEffect(() => {
    if (!ready) return;
    if (previousPathname.current !== pathname) {
      posthog.capture("$pageview", {
        $current_url: typeof window !== "undefined" ? window.location.href : undefined,
        previous_pathname: previousPathname.current ?? null,
        ...params,
      });
      previousPathname.current = pathname;
    }
  }, [ready, pathname, params]);

  return (
    <PostHogProvider client={posthog}>
      <PostHogErrorBoundary>
        <Slot />
      </PostHogErrorBoundary>
    </PostHogProvider>
  );
}
