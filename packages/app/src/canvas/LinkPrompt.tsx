import { useState } from "react";
import { Pressable, View } from "react-native";
import { Button, Icon, IconButton, Input, Text, colors, radius, shadow, space } from "@companion/design-system";

/** A small dialog asking for a URL to embed as a link card. */
export function LinkPrompt({ onSubmit, onClose }: { onSubmit: (url: string) => void; onClose: () => void }) {
  const [value, setValue] = useState("");
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
          <Text variant="title">Add a link</Text>
          <View style={{ flex: 1 }} />
          <IconButton label="Close" size="sm" onPress={onClose}>
            <Icon name="close" size={16} color={colors.textSecondary} />
          </IconButton>
        </View>
        <View style={styles.body}>
          <Input size="md" autoFocus placeholder="https://…" value={value} onChangeText={setValue} onSubmitEditing={submit} leadingIcon={<Icon name="link" size={15} color={colors.textTertiary} />} />
          <Text tone="tertiary" variant="caption">
            The page's title, description, and image are fetched for the card.
          </Text>
          <View style={styles.actions}>
            <Button label="Cancel" variant="secondary" size="sm" onPress={onClose} />
            <Button label="Add link" size="sm" onPress={submit} />
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = {
  scrim: { position: "absolute" as const, top: 0, right: 0, bottom: 0, left: 0, alignItems: "center" as const, justifyContent: "center" as const, zIndex: 50 },
  scrimFill: { position: "absolute" as const, top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "rgba(17,17,16,0.25)" },
  card: { width: 420, maxWidth: "92%" as const, backgroundColor: colors.surfaceCard, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.borderSubtle, ...shadow.lg, overflow: "hidden" as const },
  header: { flexDirection: "row" as const, alignItems: "center" as const, paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  body: { padding: space.lg, gap: space.md },
  actions: { flexDirection: "row" as const, justifyContent: "flex-end" as const, gap: space.sm },
};
