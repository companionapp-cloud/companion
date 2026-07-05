import Svg, { Path } from "react-native-svg";
import { ICON_DEFAULT_COLOR, ICON_PATHS, type IconProps } from "./iconPaths";

// Native icon: react-native-svg. Web/desktop resolve Icon.web.tsx instead (inline DOM
// <svg>), so react-native-svg never enters the react-native-web bundle.
export function Icon({ name, size = 18, color = ICON_DEFAULT_COLOR, strokeWidth = 1.75 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d={ICON_PATHS[name] ?? ICON_PATHS.dot}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
