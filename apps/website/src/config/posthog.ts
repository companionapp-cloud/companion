import posthog from "posthog-js";

// The website renders in the browser (Expo Router web / react-native-web), so it uses
// posthog-js — the web SDK — rather than posthog-react-native. Token/host come from
// EXPO_PUBLIC_* env vars, which Expo inlines at build time.

const projectToken = process.env.EXPO_PUBLIC_POSTHOG_PROJECT_TOKEN;
const host = process.env.EXPO_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com";

export const isPostHogEnabled = Boolean(projectToken && projectToken !== "phc_your_project_token_here");

if (!isPostHogEnabled) {
  console.warn(
    "PostHog project token not configured. Analytics will be disabled. " +
      "Set EXPO_PUBLIC_POSTHOG_PROJECT_TOKEN in your .env file to enable analytics.",
  );
}

/** Initialize posthog-js. Guarded to run in the browser only — Expo static export
 * pre-renders routes in Node, where window is undefined. Safe to call more than once. */
export function initPostHog(): void {
  if (typeof window === "undefined") return;
  if (!isPostHogEnabled) return;
  if (posthog.__loaded) return;

  posthog.init(projectToken as string, {
    api_host: host,
    // Pageviews are captured manually on route change (see app/_layout.tsx).
    capture_pageview: false,
    // Uncaught exceptions + unhandled promise rejections.
    capture_exceptions: true,
    before_send: (event) => {
      if (event && event.event === "$exception") {
        const exceptionList = (event.properties?.["$exception_list"] as unknown[]) || [];
        const exception = exceptionList.length > 0 ? exceptionList[0] : null;

        if (exception) {
          if (!event.properties) event.properties = {};
          event.properties["app"] = "website";
        }
      }

      return event;
    },
  });
}

export { posthog };
