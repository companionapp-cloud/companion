import { ICON_DEFAULT_COLOR, ICON_PATHS, type IconProps } from "./iconPaths";

// A plain DOM <svg> — the site is web-only, so there is no react-native-svg variant.
export function Icon({ name, size = 18, color = ICON_DEFAULT_COLOR, strokeWidth = 1.75 }: IconProps) {
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
    >
      <path d={ICON_PATHS[name] ?? ICON_PATHS.dot} />
    </svg>
  );
}
