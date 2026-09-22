import { useState } from "react";
import { View } from "react-native";
import { Button, Text, colors, radius, row, space, useDensity } from "@companion/design-system";
import { CheckBox, SettingsNote } from "../settingsUi";
import { useOnboarding, type TourStatus } from "./OnboardingProvider";
import { useOptionalOnboardingState } from "./OnboardingState";

const STATUS: Record<TourStatus, string> = { completed: "done", skipped: "skipped", new: "not seen" };

/** Settings › Tutorials: whether tutorials show at all (the welcome sheet's question), and any
 *  tutorial run again, or all of them brought back. It all syncs, so it holds on every device. */
export function TourSettings() {
  const onboarding = useOnboarding();
  const state = useOptionalOnboardingState();
  const touch = useDensity() === "touch";
  const [resetting, setResetting] = useState(false);
  if (!onboarding || !state) return <SettingsNote>No tutorials here.</SettingsNote>;
  const { tutorialsEnabled, setTutorialsEnabled } = state;
  const { tours, replay, resetAll } = onboarding;
  const allNew = tours.every((t) => t.status === "new");
  return (
    <View style={styles.section}>
      <CheckBox
        checked={tutorialsEnabled}
        onPress={() => void setTutorialsEnabled(!tutorialsEnabled)}
        label="Show a tool’s tutorial the first time you open it"
      />
      <View style={styles.list}>
        {tours.map(({ tour, status, available }, i) => (
          <View key={tour.id} style={[styles.row, { minHeight: touch ? row.touch : 32 }, i === tours.length - 1 ? null : styles.rowDivider]}>
            <Text variant="label" style={{ flex: 1 }} numberOfLines={1}>
              {tour.label}
            </Text>
            <Text variant="mono" tone={status === "new" ? "quaternary" : "tertiary"}>
              {available ? STATUS[status] : tour.id === "area" ? "needs an area" : "needs a project"}
            </Text>
            <Button
              label={status === "new" ? "Start" : "Replay"}
              variant="ghost"
              size="sm"
              disabled={!available}
              onPress={() => replay(tour.id)}
            />
          </View>
        ))}
      </View>
      <View style={styles.reset}>
        <Button
          label={resetting ? "Resetting…" : "Show all tutorials again"}
          variant="secondary"
          size="sm"
          disabled={resetting || allNew}
          onPress={() => {
            setResetting(true);
            void resetAll().finally(() => setResetting(false));
          }}
        />
        <SettingsNote>Each tutorial shows again the next time you open its tool.</SettingsNote>
      </View>
    </View>
  );
}

const styles = {
  section: { gap: space.lg },
  list: { borderWidth: 1, borderColor: colors.borderSubtle, borderRadius: radius.lg, overflow: "hidden" as const },
  row: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    paddingLeft: space.ml,
    paddingRight: space.xs,
    backgroundColor: colors.surfaceCard,
  },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  reset: { alignItems: "flex-start" as const, gap: space.sm },
};
