import { View } from "react-native";
import { Text, Button, Icon, colors, space } from "@companion/design-system";
import { useSync } from "./SyncProvider";

/** A warning banner shown across the top of the app when sync can't proceed and the user must
 * act (PLAN §7). Two cases, both resolved in Settings › Sync:
 *  - locked: an encrypted account whose key isn't loaded (e.g. a web reload) — enter the password.
 *  - needsReauth: the session expired and the refresh token is dead — sign in again.
 * It stays hidden for healthy sync and for transient network errors (which recover on their own),
 * so it only appears when there's a real, user-actionable problem. */
export function SyncHealthBanner({ onOpenSettings, topInset = 0 }: { onOpenSettings: () => void; topInset?: number }) {
  const sync = useSync();
  if (!sync.connected) return null;

  const locked = sync.status === "locked";
  const reauth = sync.needsReauth;
  if (!locked && !reauth) return null;

  const message = locked
    ? "Your notes are locked on this device. Enter your password to unlock and resume syncing."
    : "You've been signed out. Sign in again to resume syncing.";
  const action = locked ? "Unlock" : "Sign in";

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        paddingTop: space.sm + topInset,
        paddingBottom: space.sm,
        paddingHorizontal: space.lg,
        backgroundColor: colors.dangerSoft,
        borderBottomWidth: 1,
        borderBottomColor: colors.danger,
      }}
    >
      <Icon name="bell" size={16} color={colors.danger} />
      <Text variant="caption" style={{ flex: 1, color: colors.danger }}>
        {message}
      </Text>
      <Button label={action} variant="secondary" onPress={onOpenSettings} />
    </View>
  );
}
