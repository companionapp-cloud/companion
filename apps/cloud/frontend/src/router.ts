import { useSyncExternalStore } from "react";

// Minimal path router for the portal. The account area is state-driven, but the admin
// interface uses real URLs (/admin, /admin/users, …) so links are shareable and the back
// button works. navigate() pushes history and notifies subscribers; usePath() re-renders
// on navigation (push or browser back/forward).

function subscribe(cb: () => void) {
  window.addEventListener("popstate", cb);
  return () => window.removeEventListener("popstate", cb);
}

function snapshot() {
  return window.location.pathname;
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, snapshot);
}

export function navigate(path: string) {
  if (path === window.location.pathname) return;
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
