import { colors, font, radius, space } from "@companion/design-system";

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
  return (
    <input
      type="datetime-local"
      value={toLocalInputValue(value)}
      onChange={(e) => {
        const v = e.target.value;
        if (v) onSet(new Date(v).toISOString());
      }}
      style={{
        fontFamily: font.sans,
        fontSize: font.size.sm,
        color: value ? colors.textPrimary : colors.textTertiary,
        backgroundColor: colors.surfaceCard,
        border: `1px solid ${colors.borderDefault}`,
        borderRadius: radius.md,
        padding: `${space.xs}px ${space.md}px`,
        height: 28,
        width: "100%",
        boxSizing: "border-box",
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
