import { colors } from "./tokens";

export interface ProgressRingProps {
  /** 0..1 fraction filled. */
  value: number;
  size?: number;
  stroke?: number;
  color?: string;
  track?: string;
}

/** A thin circular progress ring (web/desktop: inline DOM <svg>). Powers the sidebar
 * project task-completion indicator (PLAN §6.6). The native variant uses
 * react-native-svg so it never enters the react-native-web bundle. */
export function ProgressRing({ value, size = 16, stroke = 2.5, color = colors.accent, track = colors.borderDefault }: ProgressRingProps) {
  const v = Math.max(0, Math.min(1, value));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: "rotate(-90deg)" }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeDasharray={c}
        strokeDashoffset={c * (1 - v)}
        strokeLinecap="round"
      />
    </svg>
  );
}
