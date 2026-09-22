import { useState, type ReactNode } from "react";
import { View } from "react-native";
import { Button, Icon, IconButton, Text, colors, icon, layout, row, space, useDensity, type IconName } from "@companion/design-system";
import { useNav } from "../nav-context";
import { detectIos, dismissInstallPrompt, shouldOfferInstall } from "./iosInstall";

/** The strip across the top of the app that offers installing Companion to the Home Screen: in
 *  Safari on an iPhone or iPad (iOS 16.4+), the only way to launch it full screen with its own
 *  icon, no address bar. Dismissing it snoozes it for a while. Nothing shows anywhere else, or
 *  on the install guide itself. */
export function IOSPWAInstallBanner({ leftInset = 0 }: { leftInset?: number }) {
  const nav = useNav();
  const touch = useDensity() === "touch";
  const [offerInstall, setOfferInstall] = useState(() => shouldOfferInstall());

  if (nav.activeView === "install" || !offerInstall) return null;

  const device = detectIos()?.device === "ipad" ? "iPad" : "iPhone";
  return (
    <Strip
      icon="smartphone"
      text={touch ? "Add Companion to your Home Screen." : `Add Companion to your Home Screen on this ${device}.`}
      action={<Button label="Show me how" variant="secondary" size={touch ? undefined : "sm"} onPress={() => nav.goView("install")} />}
      onDismiss={() => {
        dismissInstallPrompt();
        setOfferInstall(false);
      }}
      touch={touch}
      leftInset={leftInset}
    />
  );
}

function Strip({
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
