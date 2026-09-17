import { darkColors, lightColors, ramp, type SemanticColors } from "./palette";

// Web/desktop colours: every semantic role is a CSS custom property, so a single
// `data-theme="dark"` on the root re-points the whole app without re-rendering it.
// react-native-web passes `var(...)` colour strings through untouched. The ramp stays
// literal — it is the same in both themes. Vite/esbuild resolve this file ahead of
// colors.ts (.web.ts first), which is also how the native WebView bundles pick it up.

const cssName = (key: string) => `--c-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

const declarations = (theme: SemanticColors) =>
  (Object.keys(theme) as (keyof SemanticColors)[]).map((k) => `${cssName(k)}:${theme[k]};`).join("");

/** The stylesheet that defines both themes. Injected once at import; exported so a
 * statically rendered host can inline it ahead of hydration. */
export const themeCss =
  `:root{color-scheme:light;${declarations(lightColors)}}` +
  `[data-theme="dark"]{color-scheme:dark;${declarations(darkColors)}}`;

const STYLE_ID = "companion-theme";
if (typeof document !== "undefined" && !document.getElementById(STYLE_ID)) {
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = themeCss;
  document.head.appendChild(el);
}

const semantic = Object.fromEntries(
  (Object.keys(lightColors) as (keyof SemanticColors)[]).map((k) => [k, `var(${cssName(k)})`]),
) as unknown as SemanticColors;

export const colors: typeof ramp & SemanticColors = { ...ramp, ...semantic };

export type Colors = typeof colors;
