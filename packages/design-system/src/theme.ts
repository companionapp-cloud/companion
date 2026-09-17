import type { ThemeName } from "./palette";

// Native theme: react-native styles resolve colour literals at StyleSheet.create time, so
// the app is light-only there. Web/desktop resolve theme.web.ts, which switches themes by
// re-pointing CSS custom properties.

/** Whether this platform can switch themes at runtime. */
export const themeSwitchable = false;

export function getTheme(): ThemeName {
  return "light";
}

export function setTheme(_theme: ThemeName) {
  /* light-only on native */
}

export function toggleTheme() {
  /* light-only on native */
}

export function useTheme(): ThemeName {
  return "light";
}
