import { View } from "react-native";
import { Text, Button, Icon, colors, icon, layout, row, space, useDensity } from "@companion/design-system";
import { useSync } from "./SyncProvider";

/** A warning banner shown across the top of the app when sync can't proceed and the user must
 * act (PLAN §7). Two cases, both resolved in Settings › Sync:
 *  - locked: an encrypted account whose key isn't loaded (e.g. a web reload) — enter the password.
 *  - needsReauth: the session expired and the refresh token is dead — sign in again.
 * It stays hidden for healthy sync and for transient network errors (which recover on their own),
 * so it only appears when there's a real, user-actionable problem. */
export function SyncHealthBanner({
  onOpenSettings,
  topInset = 0,
  leftInset = 0,
}: {
  onOpenSettings: () => void;
  topInset?: number;
  /** Extra leading room kept clear for native window controls (macOS traffic lights). */
  leftInset?: number;
}) {
  const sync = useSync();
  if (!sync.connected) return null;

  const locked = sync.status === "locked";
  const reauth = sync.needsReauth;
  if (!locked && !reauth) return null;

  const message = locked
    ? "Your notes are locked on this device. Enter your password to unlock and resume syncing."
    : "You've been signed out. Sign in again to resume syncing.";
  const action = locked ? "Unlock" : "Sign in";

  // A 28px strip with a pointer; on touch it grows to a 44px row and clears the status bar.
  const touch = useDensity() === "touch";
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        minHeight: (touch ? row.touch : layout.subToolbarH) + topInset,
        paddingTop: topInset,
        paddingHorizontal: touch ? space.xl : space.lg,
        paddingLeft: (touch ? space.xl : space.lg) + leftInset,
        backgroundColor: colors.dangerSoft,
        borderBottomWidth: 1,
        borderBottomColor: colors.danger,
        flexShrink: 0,
      }}
    >
      <Icon name="lock" size={icon.sm} color={colors.danger} />
      <Text variant="caption" tone="danger" numberOfLines={touch ? 2 : 1} style={{ flex: 1 }}>
        {message}
      </Text>
      <Button label={action} variant="secondary" size={touch ? undefined : "sm"} onPress={onOpenSettings} />
    </View>
  );
}
