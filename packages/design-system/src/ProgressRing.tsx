import Svg, { Circle, Path } from "react-native-svg";
import { colors } from "./tokens";

export interface ProgressRingProps {
  /** 0..1 fraction filled. */
  value: number;
  size?: number;
  stroke?: number;
  color?: string;
  track?: string;
}

/** A thin circular progress ring (native: react-native-svg). Web/desktop resolve
 * ProgressRing.web.tsx instead (inline DOM <svg>). Powers the sidebar project
 * task-completion indicator (PLAN §6.6). When fully complete (value >= 1) the ring
 * becomes a filled check to signal "all tasks done". */
export function ProgressRing({ value, size = 16, stroke = 2.5, color = colors.accent, track = colors.borderDefault }: ProgressRingProps) {
  const v = Math.max(0, Math.min(1, value));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const center = size / 2;
  if (v >= 1) {
    // A full accent ring with a check inside — the completion state.
    return (
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <Circle cx={center} cy={center} r={r} fill="none" stroke={color} strokeWidth={stroke} />
        <Path
          d={`M${0.29 * size} ${0.52 * size} L${0.43 * size} ${0.66 * size} L${0.71 * size} ${0.35 * size}`}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    );
  }
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <Circle cx={center} cy={center} r={r} fill="none" stroke={track} strokeWidth={stroke} />
      <Circle
        cx={center}
        cy={center}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeDasharray={`${c} ${c}`}
        strokeDashoffset={c * (1 - v)}
        strokeLinecap="round"
        transform={`rotate(-90 ${center} ${center})`}
      />
    </Svg>
  );
}
