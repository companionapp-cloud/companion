import Svg, { Circle, Path, Rect } from "react-native-svg";
import { colors } from "./tokens";

export interface BrandMarkProps {
  size?: number;
  /** Rounded-square backdrop. Pass "transparent" to render just the mark. */
  background?: string;
  /** The "C" arc + companion dot. */
  color?: string;
}

// The Companion app icon — an open "C" arc with a companion dot — reused wherever the
// brand shows up (e.g. the sidebar). Geometry is lifted from the exported app-icon SVG
// (M70 33 A24 24 0 1 0 70 67 + dot at 72,50) and pre-scaled into a 0..100 box so this
// renders pixel-identical to BrandMark.web.tsx without relying on <G> transform parsing.
//
// Native path (react-native-svg). Web/desktop resolve BrandMark.web.tsx instead.
export function BrandMark({ size = 26, background = colors.accent, color = colors.onAccent }: BrandMarkProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100" fill="none">
      <Rect width={100} height={100} rx={22} fill={background} />
      <Path d="M61.2 40.48 A13.44 13.44 0 1 0 61.2 59.52" stroke={color} strokeWidth={4.2} strokeLinecap="round" fill="none" />
      <Circle cx={62.32} cy={50} r={4.2} fill={color} />
    </Svg>
  );
}
