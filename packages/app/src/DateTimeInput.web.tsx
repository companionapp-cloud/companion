import { useState } from "react";
import { colors, control, font, motion, radius, space, useDensity } from "@companion/design-system";

export interface DateTimeInputProps {
  /** Current value as an ISO string, or null. */
  value?: string | null;
  /** Called with a new ISO string when the user picks a date/time. */
  onSet: (iso: string) => void;
}

/** A concrete date+time picker. On web/desktop this is the native
 *  `<input type="datetime-local">` (RNW renders into the DOM, so a real input is fine);
 *  the native build has its own stub. */
export function DateTimeInput({ value, onSet }: DateTimeInputProps) {
  const touch = useDensity() === "touch";
  const [focused, setFocused] = useState(false);
  return (
    <input
      type="datetime-local"
      value={toLocalInputValue(value)}
      onChange={(e) => {
        const v = e.target.value;
        if (v) onSet(new Date(v).toISOString());
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      // Matches the design system's `Input` (sm, mono): the value is a machine date.
      style={{
        fontFamily: font.mono,
        // 16px on touch keeps iOS Safari from zooming the page into the focused field.
        fontSize: touch ? 16 : font.size.xs,
        color: value ? colors.textPrimary : colors.textQuaternary,
        backgroundColor: colors.surfaceCard,
        border: `1px solid ${focused ? colors.borderFocus : colors.borderDefault}`,
        boxShadow: focused ? `0 0 0 2px ${colors.focusRing}` : "none",
        borderRadius: radius.md,
        padding: `0 ${space.sm}px`,
        height: touch ? control.lg : control.sm,
        width: "100%",
        boxSizing: "border-box",
        outline: "none",
        transition: `border-color ${motion.fast}ms ${motion.ease}, box-shadow ${motion.fast}ms ${motion.ease}`,
      }}
    />
  );
}

/** ISO → the "YYYY-MM-DDTHH:mm" local value the datetime-local input expects. */
function toLocalInputValue(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
