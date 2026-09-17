import { ICON_DEFAULT_COLOR, ICON_PATHS, ICON_STROKE, type IconProps } from "./iconPaths";

// Web/desktop icon: a plain DOM <svg>. This variant is resolved by Vite (.web.tsx
// first), so react-native-web builds never pull react-native-svg (whose Fabric native
// components import React Native internals absent from react-native-web).
export function Icon({ name, size = 14, color = ICON_DEFAULT_COLOR, strokeWidth = ICON_STROKE }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: "block", flexShrink: 0 }}
    >
      <path d={ICON_PATHS[name] ?? ICON_PATHS.dot} />
    </svg>
  );
}
