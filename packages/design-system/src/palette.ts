// Raw colour values for both themes. `colors` (colors.ts / colors.web.ts) is what
// consumers import; this file is the literal source those resolve from. Reach for
// `lightColors` / `darkColors` directly only when a literal is required — colour math,
// a 2D canvas context, or a surface that must not follow the theme.

/** Theme-independent ramps: warm-neutral grays, the orange accent, raw semantic hues. */
export const ramp = {
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
} as const;

/** The semantic layer. Consumers reference these roles, never the ramp directly. */
export interface SemanticColors {
  // Text
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  /** Quaternary ink: mono metadata, quiet icons. */
  textQuaternary: string;
  textDisabled: string;
  textInverse: string;
  textAccent: string;

  // Surfaces
  surfaceApp: string;
  surfaceCard: string;
  surfaceSunken: string;
  surfaceHover: string;
  surfaceActive: string;
  surfaceSelected: string;
  surfaceOverlay: string;
  surfaceCode: string;
  scrim: string;

  // Borders
  borderSubtle: string;
  borderDefault: string;
  borderStrong: string;
  borderFocus: string;
  /** The 2px focus halo colour (drawn as a box-shadow spread on web). */
  focusRing: string;

  // Accent / primary action
  accent: string;
  accentHover: string;
  accentActive: string;
  accentSoft: string;
  accentSoftBorder: string;
  onAccent: string;

  // Semantic feedback (muted; text and hairline scale only)
  success: string;
  warning: string;
  danger: string;
  dangerSoft: string;
  dangerSoftHover: string;
  dangerSoftActive: string;
  info: string;
  infoSoft: string;
  infoActive: string;
}

export const lightColors: SemanticColors = {
  textPrimary: ramp.gray900,
  textSecondary: ramp.gray600,
  textTertiary: ramp.gray500,
  textQuaternary: ramp.gray400,
  textDisabled: ramp.gray400,
  textInverse: ramp.gray0,
  textAccent: ramp.orange600,

  surfaceApp: ramp.gray50,
  surfaceCard: ramp.gray0,
  surfaceSunken: ramp.gray100,
  surfaceHover: ramp.gray100,
  surfaceActive: ramp.gray200,
  surfaceSelected: ramp.orange50,
  surfaceOverlay: ramp.gray0,
  surfaceCode: ramp.gray50,
  scrim: "rgba(17,17,16,0.32)",

  borderSubtle: ramp.gray200,
  borderDefault: ramp.gray300,
  borderStrong: ramp.gray400,
  borderFocus: ramp.orange500,
  focusRing: "rgba(247,104,8,0.28)",

  accent: ramp.orange500,
  accentHover: ramp.orange600,
  accentActive: ramp.orange700,
  accentSoft: ramp.orange50,
  accentSoftBorder: ramp.orange200,
  onAccent: ramp.gray0,

  success: "#2e9e5b",
  warning: "#d68a0c",
  danger: "#d64545",
  dangerSoft: "#fbecec",
  dangerSoftHover: "#f6dede",
  dangerSoftActive: "#efd0d0",
  info: "#3b74d6",
  infoSoft: "#eaf1fb",
  infoActive: "#2b579e",
};

/** Dark is the same warm ramp pushed down, not an inversion. */
export const darkColors: SemanticColors = {
  textPrimary: "#ededea",
  textSecondary: "#a7a7a1",
  textTertiary: "#8a8a83",
  textQuaternary: "#6b6b65",
  textDisabled: "#6b6b65",
  textInverse: "#111110",
  textAccent: "#ff8f4d",

  surfaceApp: "#121211",
  surfaceCard: "#1a1a18",
  surfaceSunken: "#0d0d0c",
  surfaceHover: "#232320",
  surfaceActive: "#2d2d29",
  surfaceSelected: "#2a1a0e",
  surfaceOverlay: "#1f1f1c",
  surfaceCode: "#0d0d0c",
  scrim: "rgba(0,0,0,0.55)",

  borderSubtle: "#2a2a27",
  borderDefault: "#3a3a36",
  borderStrong: "#55554f",
  borderFocus: ramp.orange500,
  focusRing: "rgba(247,104,8,0.35)",

  accent: ramp.orange500,
  accentHover: ramp.orange600,
  accentActive: ramp.orange700,
  accentSoft: "#2a1a0e",
  accentSoftBorder: "#4d2a10",
  onAccent: ramp.gray0,

  success: "#2e9e5b",
  warning: "#d68a0c",
  danger: "#e86a6a",
  dangerSoft: "#2c1616",
  dangerSoftHover: "#381b1b",
  dangerSoftActive: "#452121",
  info: "#6f9df0",
  infoSoft: "#14202f",
  infoActive: "#8fb3f5",
};

export type ThemeName = "light" | "dark";
