// Design tokens — the single source of truth for Companion's visual language: a warm-gray
// ramp with a single orange accent, Geist typography, and the dense-redesign metrics
// (13px UI base, 24px rows, 22/26/30 controls, 2–8px radii, hairlines instead of shadows).
// Colours live in colors.ts (literals on native, CSS custom properties on web so
// `data-theme="dark"` works); everything else is a literal because react-native styles
// take numbers.

export { colors, type Colors } from "./colors";
export { ramp, lightColors, darkColors, type SemanticColors, type ThemeName } from "./palette";

/** 2px base grid. Chrome lives in 4–12px; 16px and up is for page gutters and prose. */
export const space = {
  xxs: 2,
  xs: 4,
  sm: 6,
  md: 8,
  ml: 10,
  lg: 12,
  xl: 16,
  xl2: 20,
  xxl: 24,
  xxxl: 32,
  huge: 40,
} as const;

/** Corner radii — chrome reads as panels, not pills. Only avatars and numeric count
 * badges stay fully round. */
export const radius = {
  /** Inline chips, tab affordances. */
  xs: 2,
  /** Rows, tabs, badges, small buttons. */
  sm: 3,
  /** Inputs, buttons. */
  md: 4,
  /** Panels, code blocks, cards. */
  lg: 6,
  /** Overlays, the app tile. */
  xl: 8,
  /** @deprecated Same as `xl`; the redesign tops out at 8px. */
  xxl: 8,
  full: 999,
} as const;

/** Typography. Geist for UI, Geist Mono for everything the machine owns: timestamps,
 * versions, counts, ids, paths, shortcut hints and section eyebrows. */
export const font = {
  sans: 'Geist, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: '"Geist Mono", ui-monospace, "SF Mono", Menlo, monospace',
  size: {
    "2xs": 10,
    xs: 11,
    sm: 12,
    /** The UI base. */
    base: 13,
    /** Document prose — the one surface that goes up a step, because it is for reading. */
    md: 14,
    lg: 15,
    xl: 17,
    "2xl": 20,
    "3xl": 24,
    display: 30,
  },
  weight: {
    regular: "400",
    medium: "500",
    semibold: "600",
    /** Marketing only. */
    bold: "700",
  },
  // react-native letterSpacing is absolute px (no em); these approximate the system's
  // em tracking at the size each is used with (tight @30, snug @15–17, wide/eyebrow @10–11).
  tracking: {
    tight: -0.75,
    snug: -0.18,
    normal: 0,
    wide: 0.66,
    eyebrow: 1.2,
  },
  /** Line-height multipliers; react-native lineHeight is px, so multiply by the size. */
  leading: {
    tight: 1.15,
    ui: 1.35,
    prose: 1.6,
  },
} as const;

/** Shadows are only for things that float above the document: `md` for menus and
 * popovers, `lg` for dialogs and quick capture. Flat chrome — toolbars, panels, cards,
 * rows — gets a hairline and no shadow. Expressed as react-native shadow props (RNW maps
 * these to box-shadow; native uses them directly). */
export const shadow = {
  sm: { shadowColor: "#111110", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 2, elevation: 1 },
  md: { shadowColor: "#111110", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.1, shadowRadius: 12, elevation: 4 },
  lg: { shadowColor: "#111110", shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.16, shadowRadius: 28, elevation: 12 },
} as const;

/** Control heights. `md` is the pointer default; touch surfaces use `lg`. */
export const control = {
  xs: 20,
  sm: 22,
  md: 26,
  lg: 30,
} as const;

/** Row heights. Pointer lists are 24px (38px only when a subtitle earns it); touch rows
 * never drop below 44px. */
export const row = {
  h: 24,
  twoLine: 38,
  touch: 44,
} as const;

/** Icon sizes: 12 beside mono metadata and in tabs, 14 in toolbars and rows, 16 in the
 * rail, 20 in mobile tiles. Stroke is always 1.5; icons are never filled. */
export const icon = {
  sm: 12,
  md: 14,
  lg: 16,
  tile: 20,
  stroke: 1.5,
} as const;

/** App layout dimensions. */
export const layout = {
  railW: 44,
  railOpenW: 208,
  listW: 260,
  panelW: 280,
  titlebarH: 32,
  toolbarH: 36,
  subToolbarH: 28,
  statusbarH: 22,
  contentMax: 720,
} as const;

/** Motion is functional only: one ease, three durations. Content never animates in. */
export const motion = {
  ease: "cubic-bezier(0.2, 0, 0.2, 1)",
  /** Press/hover fills. */
  instant: 80,
  /** Colour and border changes. */
  fast: 120,
  /** Layout reveals: rail expand, panel toggle. */
  medium: 200,
} as const;

/** A small categorical palette for user-picked colors (archetypes, feeds, canvas
 * stickies/groups/arrows). One list so every picker offers the same swatches. */
export const swatches = [
  "#8b5cf6",
  "#ec4899",
  "#f59e0b",
  "#14b8a6",
  "#6366f1",
  "#ef4444",
  "#10b981",
  "#eab308",
  "#3b82f6",
  "#64748b",
] as const;
