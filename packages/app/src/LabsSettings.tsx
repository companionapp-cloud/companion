import { View } from "react-native";
import { space } from "@companion/design-system";
import { CheckBox, SettingsField, SettingsNote } from "./settingsUi";
import { setLabsFlag, useLabsFlag } from "./labs";

/** Settings › Labs: experiments to opt into, on this device. */
export function LabsSettings() {
  const ancient = useLabsFlag("ancientMediums");
  return (
    <View style={{ gap: space.xl }}>
      <SettingsNote>Half-finished ideas and things we can't justify. Each switch only affects this device.</SettingsNote>
      <SettingsField
        label="Include less modern mediums"
        help={
          <>
            Paper is so second century. This adds clay tablets, wax tablets and potsherds to New notebook: pen only, no keyboard, as the Sumerians intended.
            Side effects may include cuneiform, strong opinions about beeswax, and explaining ostracism at dinner parties. Notebooks already made of mud stay
            put if you turn this off.
          </>
        }
      >
        <CheckBox checked={ancient} onPress={() => setLabsFlag("ancientMediums", !ancient)} label="Yes, I would like to write on dirt" />
      </SettingsField>
    </View>
  );
}
