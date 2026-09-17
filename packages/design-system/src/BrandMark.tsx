import Svg, { Circle, Path, Rect } from "react-native-svg";
import { colors } from "./tokens";
import type { BrandMarkProps } from "./BrandMark.types";


// The Companion app icon — an open "C" arc with a companion dot — reused wherever the
// brand shows up (e.g. the sidebar). Geometry is lifted from the exported app-icon SVG
// (M70 33 A24 24 0 1 0 70 67 + dot at 72,50) and pre-scaled into a 0..100 box so this
// renders pixel-identical to BrandMark.web.tsx without relying on <G> transform parsing.
//
// Native path (react-native-svg). Web/desktop resolve BrandMark.web.tsx instead.
export function BrandMark({ size = 20, variant = "tile", background = colors.accent, color }: BrandMarkProps) {
  const ink = color ?? (variant === "mono" ? colors.textPrimary : colors.onAccent);
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100" fill="none">
      {variant === "tile" ? <Rect width={100} height={100} rx={14} fill={background} /> : null}
      <Path d="M61.2 40.48 A13.44 13.44 0 1 0 61.2 59.52" stroke={ink} strokeWidth={4.2} strokeLinecap="round" fill="none" />
      <Circle cx={62.32} cy={50} r={4.2} fill={ink} />
    </Svg>
  );
}
