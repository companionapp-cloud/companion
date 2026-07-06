import { colors } from "./tokens";
import type { BrandMarkProps } from "./BrandMark";

// Web/desktop variant of BrandMark: a plain DOM <svg>, resolved by Vite (.web.tsx first)
// so react-native-web builds never pull react-native-svg. Geometry mirrors BrandMark.tsx.
export function BrandMark({ size = 26, background = colors.accent, color = colors.onAccent }: BrandMarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="100" height="100" rx="22" fill={background} />
      <path d="M61.2 40.48 A13.44 13.44 0 1 0 61.2 59.52" stroke={color} strokeWidth="4.2" strokeLinecap="round" fill="none" />
      <circle cx="62.32" cy="50" r="4.2" fill={color} />
    </svg>
  );
}
