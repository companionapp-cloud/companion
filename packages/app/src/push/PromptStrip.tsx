import type { ReactNode } from "react";
import { View } from "react-native";
import { Icon, IconButton, Text, colors, icon, layout, row, space, type IconName } from "@companion/design-system";

/** The dismissible offer strip across the top of the app, shared by the install banner and the
 *  notifications banner: a glyph, one line of text (two on touch), an action and a close button. */
export function PromptStrip({
  icon: iconName,
  text,
  action,
  onDismiss,
  touch,
  leftInset,
}: {
  icon: IconName;
  text: string;
  action: ReactNode;
  onDismiss: () => void;
  touch: boolean;
  leftInset: number;
}) {
  // A 28px strip with a pointer; on touch a 44px row — the SyncHealthBanner's proportions, in the
  // accent wash rather than danger: an offer, not a problem.
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        minHeight: touch ? row.touch : layout.subToolbarH,
        paddingVertical: touch ? space.sm : 0,
        paddingLeft: (touch ? space.xl : space.lg) + leftInset,
        paddingRight: touch ? space.sm : space.md,
        backgroundColor: colors.accentSoft,
        borderBottomWidth: 1,
        borderBottomColor: colors.accentSoftBorder,
        flexShrink: 0,
      }}
    >
      <Icon name={iconName} size={icon.sm} color={colors.textAccent} />
      <Text variant="caption" numberOfLines={touch ? 2 : 1} style={{ flex: 1 }}>
        {text}
      </Text>
      {action}
      <IconButton label="Dismiss" size={touch ? "lg" : "sm"} onPress={onDismiss}>
        <Icon name="close" size={touch ? 16 : icon.sm} color={colors.textTertiary} />
      </IconButton>
    </View>
  );
}
