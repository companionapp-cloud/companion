import { View } from "react-native";
import { Text, colors, control, radius, space, useDensity } from "@companion/design-system";

export interface DateTimeInputProps {
  value?: string | null;
  onSet: (iso: string) => void;
}

/** Native fallback: no OS date picker is bundled on mobile yet (it needs a native module),
 *  so this is a read-only display of the current value — the same "field shows the date"
 *  shape as the web picker. Setting the date is via the natural-language field and presets.
 *  The web build (DateTimeInput.web.tsx) is an editable picker. */
export function DateTimeInput({ value }: DateTimeInputProps) {
  const touch = useDensity() === "touch";
  return (
    <View style={[styles.box, { height: touch ? control.lg : control.sm }]}>
      <Text variant="mono" tone={value ? "secondary" : "quaternary"} numberOfLines={1}>
        {value ? formatWhen(value) : "no date set"}
      </Text>
    </View>
  );
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const styles = {
  // Reads as a disabled `Input`: sunken fill, default border, mono value.
  box: {
    justifyContent: "center" as const,
    paddingHorizontal: space.sm,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSunken,
  },
};
