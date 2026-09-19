import { View } from "react-native";
import { Button, Text, space } from "@companion/design-system";
import { useCore } from "./CoreContext";
import { SettingsNote } from "./settingsUi";
import { openThingsImport } from "./ThingsImport";
import { canPickThingsSource } from "./thingsSource";

/** Settings › Import (PLAN §6.12): bring work over from another app. Things 3 is the first
 *  source; its button opens the import dialog, where the user picks the database and chooses
 *  what to bring. Same section on every shell. */
export function ImportSettings() {
  const { core } = useCore();
  const available = canPickThingsSource(core);
  return (
    <View style={styles.page}>
      <View style={styles.section}>
        <Text variant="eyebrow" tone="quaternary">
          Things 3
        </Text>
        <SettingsNote>
          Bring your Inbox, areas and projects over from Things 3 — with their headings, notes, checklists, dates, reminders and
          repeating to-dos. You choose which areas and projects to import, and whether to include completed to-dos.
        </SettingsNote>
        <View style={styles.actions}>
          <Button label="Import from Things 3…" variant="secondary" disabled={!available} onPress={openThingsImport} />
        </View>
        {!available ? <SettingsNote>Choosing a file isn’t available on this device.</SettingsNote> : null}
      </View>
    </View>
  );
}

const styles = {
  page: { gap: space.xl },
  section: { gap: space.sm },
  actions: { flexDirection: "row" as const, marginTop: space.xs },
};
