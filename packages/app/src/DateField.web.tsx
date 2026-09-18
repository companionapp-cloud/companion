import { useState } from "react";
import { colors, control, font, motion, radius, space, useDensity } from "@companion/design-system";

export interface DateFieldProps {
  /** "YYYY-MM-DD" (kind "date") or "HH:MM" (kind "time"), in LOCAL terms; "" when unset. */
  value: string;
  onChange: (value: string) => void;
  kind: "date" | "time";
  ariaLabel?: string;
}

/** A plain date or time field. On web/desktop it is the browser's own `<input type="date|time">`
 *  (react-native-web renders into the DOM, so a real input is fine) — it brings the calendar
 *  popover, keyboard entry and locale formatting for free. Unlike DateTimeInput it edits the date
 *  and the time separately, which is what an event needs: move the day without touching the
 *  hours, or have no time at all. */
export function DateField({ value, onChange, kind, ariaLabel }: DateFieldProps) {
  const touch = useDensity() === "touch";
  const [focused, setFocused] = useState(false);
  return (
    <input
      type={kind}
      value={value}
      aria-label={ariaLabel}
      step={kind === "time" ? 300 : undefined}
      onChange={(e) => {
        // Clearing the field yields ""; an event always has a date and a time, so ignore it.
        if (e.target.value) onChange(e.target.value);
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        fontFamily: font.mono,
        fontSize: touch ? 16 : font.size.xs, // 16px keeps iOS Safari from zooming into the field
        color: colors.textPrimary,
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
