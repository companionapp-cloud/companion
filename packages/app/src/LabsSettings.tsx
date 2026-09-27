import { View } from "react-native";
import { Text, colors, radius, space } from "@companion/design-system";
import { CheckBox, SettingsField, SettingsNote } from "./settingsUi";
import { setLabsFlag, useLabsFlag } from "./labs";

/** Settings › Labs: experiments to opt into, on this device. Every switch starts off. */
export function LabsSettings() {
  const notebooks = useLabsFlag("notebooks");
  const ancient = useLabsFlag("ancientMediums");
  const bindings = useLabsFlag("notebookBindings");
  return (
    <View style={{ gap: space.xl }}>
      <SettingsNote>Lab features are subject to change. You may lose data, use at your own risk. Each switch only affects this device.</SettingsNote>
      <View style={styles.card}>
        <Text variant="title">Notebooks</Text>
        <SettingsField
          label="Enable Notebooks"
          help="Notebooks allow you to write and draw in a physical representation of a notebook. Great for collecting notes about a specific subject, such as journalling or field notes."
        >
          <CheckBox checked={notebooks} onPress={() => setLabsFlag("notebooks", !notebooks)} label="Enabled" ariaLabel="Enable Notebooks" />
        </SettingsField>
        <SettingsField
          label="Enable ancient mediums for notebooks"
          help="Paper is so second century. This adds clay tablets, wax tablets and potsherds to New notebook: pen only, no keyboard, as the Sumerians intended. Side effects may include cuneiform, strong opinions about beeswax, and explaining ostracism at dinner parties."
        >
          <CheckBox checked={ancient} onPress={() => setLabsFlag("ancientMediums", !ancient)} label="Enabled" ariaLabel="Enable ancient mediums for notebooks" />
        </SettingsField>
        <SettingsField
          label="Enable notebook bindings"
          help="Choose how a new paper notebook is held together: a sewn journal, a spiral notebook, a reporter's pad, a ring binder, a stapled pocket notebook, a traveler's notebook, a box of index cards or a concertina. Each binding has its own rules about adding, tearing out and moving pages."
        >
          <CheckBox checked={bindings} onPress={() => setLabsFlag("notebookBindings", !bindings)} label="Enabled" ariaLabel="Enable notebook bindings" />
        </SettingsField>
      </View>
    </View>
  );
}

const styles = {
  card: {
    gap: space.lg,
    padding: space.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceCard,
  },
};
