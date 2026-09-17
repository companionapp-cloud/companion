import { useSyncExternalStore } from "react";
import type { ThemeName } from "./palette";

// The theme is a persisted per-device preference applied as `data-theme` on <html>;
// colors.web.ts's custom properties do the rest. Applied at import so the first paint is
// already in the right theme.

const STORAGE_KEY = "companion.theme";
const listeners = new Set<() => void>();

function read(): ThemeName {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

let current: ThemeName = read();

function apply(theme: ThemeName) {
  if (typeof document !== "undefined") document.documentElement.setAttribute("data-theme", theme);
}
apply(current);

/** Whether this platform can switch themes at runtime. */
export const themeSwitchable = true;

export function getTheme(): ThemeName {
  return current;
}

export function setTheme(theme: ThemeName) {
  if (theme === current) return;
  current = theme;
  apply(theme);
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, theme);
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l());
}

export function toggleTheme() {
  setTheme(current === "dark" ? "light" : "dark");
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The active theme; re-renders on change. Colours follow the theme through CSS, so only
 * chrome that *names* the theme (the toggle) needs this. */
export function useTheme(): ThemeName {
  return useSyncExternalStore(subscribe, getTheme, () => "light" as ThemeName);
}
