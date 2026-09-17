import { lightColors, ramp, type SemanticColors } from "./palette";

// Native colours: react-native styles take literals, so the semantic layer resolves to the
// light theme here. Web/desktop resolve colors.web.ts instead, where each role is a CSS
// custom property and `data-theme="dark"` re-points them.
export const colors: typeof ramp & SemanticColors = { ...ramp, ...lightColors };

export type Colors = typeof colors;
