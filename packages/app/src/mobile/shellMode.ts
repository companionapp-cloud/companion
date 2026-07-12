import { useMemo } from "react";
import { useWindowDimensions } from "react-native";

// Decides which shell the web app mounts: the desktop AppShell (hover rail + workspace
// tabs) or the MobileWebShell (Home list + pushed full-screen routes). Anything under
// 1024px gets the mobile shell — the desktop rail + list/editor split needs the room,
// and its core interactions (hover-revealed rail, drag & drop) assume a pointer anyway.

/** `?shell=mobile|desktop` forces a shell (handy for testing + as an escape hatch). */
function shellOverride(): "mobile" | "desktop" | null {
  if (typeof window === "undefined" || !window.location?.search) return null;
  const v = new URLSearchParams(window.location.search).get("shell");
  return v === "mobile" || v === "desktop" ? v : null;
}

/** The desktop shell needs at least this much width for its rail + workspace split. */
const DESKTOP_MIN_WIDTH = 1024;

/** True when the viewport wants the mobile shell. Re-evaluates on resize and rotation
 * (useWindowDimensions), so the shells hot-swap; data lives in the core, so a swap just
 * remounts chrome. */
export function useMobileWebShell(): boolean {
  const { width } = useWindowDimensions();
  const override = useMemo(shellOverride, []);
  if (override) return override === "mobile";
  return width < DESKTOP_MIN_WIDTH;
}
