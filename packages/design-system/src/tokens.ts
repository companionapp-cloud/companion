// Design tokens — the single source of truth for Companion's visual language.
// Ported from the Companion design system (warm-gray ramp + a single orange accent,
// Geist typography, generous rounding, low diffuse shadows). CSS variable aliases
// are resolved to concrete values here because react-native styles take literals.

/** Warm-neutral ramp + orange accent + muted semantic hues, plus semantic aliases. */
export const colors = {
  // Neutral ramp (very slightly warm gray)
  gray0: "#ffffff",
  gray25: "#fafaf9",
  gray50: "#f5f5f3",
  gray100: "#ededea",
  gray200: "#e0e0dc",
  gray300: "#cececa",
  gray400: "#a7a7a1",
  gray500: "#7b7b75",
  gray600: "#595954",
  gray700: "#3e3e3a",
  gray800: "#2a2a27",
  gray900: "#1a1a18",
  gray950: "#111110",

  // Orange accent
  orange50: "#fff4ed",
  orange100: "#ffe5d4",
  orange200: "#feccab",
  orange500: "#f76808",
  orange600: "#e04e02",
  orange700: "#b83a05",

  // Text
  textPrimary: "#1a1a18",
  textSecondary: "#595954",
  textTertiary: "#7b7b75",
  textDisabled: "#a7a7a1",
  textInverse: "#ffffff",
  textAccent: "#e04e02",

  // Surfaces
  surfaceApp: "#f5f5f3",
  surfaceCard: "#ffffff",
  surfaceSunken: "#ededea",
  surfaceHover: "#ededea",
  surfaceActive: "#e0e0dc",

  // Borders
  borderSubtle: "#e0e0dc",
  borderDefault: "#cececa",
  borderStrong: "#a7a7a1",
  borderFocus: "#f76808",

  // Accent / primary action
  accent: "#f76808",
  accentHover: "#e04e02",
  accentActive: "#b83a05",
  accentSoft: "#fff4ed",
  accentSoftBorder: "#feccab",
  onAccent: "#ffffff",

  // Semantic feedback (muted, used sparingly)
  success: "#2e9e5b",
  warning: "#d68a0c",
  danger: "#d64545",
  dangerSoft: "#fbecec",
  info: "#3b74d6",
  infoSoft: "#eaf1fb",
  infoActive: "#2b579e",
} as const;

/** 4px base grid. */
export const space = {
  xs: 4,
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  xxl: 24,
  xxxl: 32,
} as const;

/** Corner radii — rounded is core to the brand. */
export const radius = {
  xs: 4,
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  xxl: 20,
  full: 999,
} as const;

/** Typography. Geist for UI, Geist Mono for ids/metadata/code. */
export const font = {
  sans: 'Geist, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: '"Geist Mono", ui-monospace, "SF Mono", Menlo, monospace',
  size: {
    "2xs": 11,
    xs: 12,
    sm: 13,
    base: 14,
    md: 15,
    lg: 17,
    xl: 20,
    "2xl": 24,
    "3xl": 30,
  },
  weight: {
    regular: "400",
    medium: "500",
    semibold: "600",
    bold: "700",
  },
  // react-native letterSpacing is absolute px (no em); approximations of the
  // design system's tight tracking on display sizes.
  tracking: {
    tight: -0.5,
    snug: -0.2,
    normal: 0,
    wide: 0.5,
  },
} as const;

/** Low, diffuse, neutral shadows expressed as react-native shadow props (RNW maps
 * these to box-shadow; native uses them directly). */
export const shadow = {
  sm: { shadowColor: "#111110", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 3, elevation: 1 },
  md: { shadowColor: "#111110", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.1, shadowRadius: 12, elevation: 4 },
  lg: { shadowColor: "#111110", shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.14, shadowRadius: 28, elevation: 12 },
} as const;

/** Control heights. */
export const control = {
  sm: 28,
  md: 34,
  lg: 40,
} as const;

/** App layout dimensions. */
export const layout = {
  railW: 56,
  railOpenW: 232,
  listW: 300,
  titlebarH: 44,
  toolbarH: 52,
  contentMax: 760,
} as const;

export type Colors = typeof colors;
