import { useState } from "react";
import { Pressable, View } from "react-native";
import { Button, Icon, IconButton, Input, Text, colors, icon, layout, radius, shadow, space, useDensity } from "@companion/design-system";

/** A small dialog asking for a URL to embed as a link card. */
export function LinkPrompt({ onSubmit, onClose }: { onSubmit: (url: string) => void; onClose: () => void }) {
  const [value, setValue] = useState("");
  // Desktop density is for pointers; under touch the controls fall back to their 30px default.
  const touch = useDensity() === "touch";
  const submit = () => {
    const v = value.trim();
    if (v) onSubmit(v);
    else onClose();
  };
  return (
    <View style={styles.scrim}>
      <Pressable style={styles.scrimFill} onPress={onClose} aria-label="Close" />
      <View style={styles.card}>
        <View style={styles.header}>
          <Text variant="label">Add a link</Text>
          <View style={{ flex: 1 }} />
          <IconButton label="Close" size={touch ? undefined : "sm"} onPress={onClose}>
            <Icon name="close" size={icon.sm} color={colors.textSecondary} />
          </IconButton>
        </View>
        <View style={styles.body}>
          <Input size={touch ? undefined : "sm"} mono autoFocus autoCapitalize="none" placeholder="https://…" value={value} onChangeText={setValue} onSubmitEditing={submit} leadingIcon={<Icon name="link" size={icon.sm} color={colors.textQuaternary} />} />
          <Text tone="tertiary" variant="caption">
            The page's title, description, and image are fetched for the card.
          </Text>
          <View style={styles.actions}>
            <Button label="Cancel" variant="ghost" size={touch ? undefined : "sm"} onPress={onClose} />
            <Button label="Add link" size={touch ? undefined : "sm"} kbd={touch ? undefined : "⏎"} onPress={submit} />
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = {
  scrim: { position: "absolute" as const, top: 0, right: 0, bottom: 0, left: 0, alignItems: "center" as const, justifyContent: "center" as const, zIndex: 50 },
  scrimFill: { position: "absolute" as const, top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.scrim },
  // A floating picker, not a dialog: overlay surface, hairline, 6px radius, the menu shadow.
  card: { width: 420, maxWidth: "92%" as const, backgroundColor: colors.surfaceOverlay, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.borderSubtle, ...shadow.md, overflow: "hidden" as const },
  header: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm, minHeight: layout.subToolbarH, paddingLeft: space.ml, paddingRight: space.xs, borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  body: { padding: space.ml, gap: space.md },
  actions: { flexDirection: "row" as const, justifyContent: "flex-end" as const, gap: space.sm },
};
