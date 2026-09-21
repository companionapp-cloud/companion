import { Pressable, StyleSheet, View } from "react-native";
import { Text, Button, Icon, colors, icon, layout, motion, radius, row, space, transition, useDensity, type PressState } from "@companion/design-system";
import { useSync, type SyncController } from "./SyncProvider";

export type SyncBlocker = "locked" | "reauth";

/** Why sync can't proceed until the user acts (PLAN §7), or null. Two cases, both resolved in
 * Settings › Sync and checked in the same order that page checks them:
 *  - locked: an encrypted account whose key isn't loaded (e.g. a web reload) — enter the password.
 *  - reauth: the session expired and the refresh token is dead — sign in again.
 * Healthy sync and transient network errors (which recover on their own) are null, so the
 * prompts below only appear when there's a real, user-actionable problem. */
export function syncBlocker(sync: SyncController): SyncBlocker | null {
  if (!sync.connected) return null;
  if (sync.status === "locked") return "locked";
  return sync.needsReauth ? "reauth" : null;
}

/** The mobile shells' prompt: a warning banner across the top of the app. (The desktop shell
 * puts a SyncHealthChip in its status bar instead.) */
export function SyncHealthBanner({ onOpenSettings, topInset = 0 }: { onOpenSettings: () => void; topInset?: number }) {
  const blocker = syncBlocker(useSync());
  // A 28px strip with a pointer; on touch it grows to a 44px row and clears the status bar.
  const touch = useDensity() === "touch";
  if (!blocker) return null;

  const message =
    blocker === "locked"
      ? "Your notes are locked on this device. Enter your password to unlock and resume syncing."
      : "You've been signed out. Sign in again to resume syncing.";
  const action = blocker === "locked" ? "Unlock" : "Sign in";

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        minHeight: (touch ? row.touch : layout.subToolbarH) + topInset,
        paddingTop: topInset,
        paddingHorizontal: touch ? space.xl : space.lg,
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

/** The desktop shell's prompt: a red chip that leads the status bar, standing in for its
 * sync dot, and opens Settings › Sync. */
export function SyncHealthChip({ blocker, onOpenSettings }: { blocker: SyncBlocker; onOpenSettings: () => void }) {
  return (
    <Pressable
      onPress={onOpenSettings}
      aria-label={blocker === "locked" ? "Sync is locked. Unlock to resume syncing." : "Session expired. Sign in to resume syncing."}
      style={({ hovered, pressed }: PressState) => [
        styles.chip,
        transition("background-color", motion.instant),
        { backgroundColor: pressed ? colors.dangerSoftActive : hovered ? colors.dangerSoftHover : colors.dangerSoft },
      ]}
    >
      <Icon name="lock" size={10} color={colors.danger} />
      <Text variant="mono" tone="danger" numberOfLines={1}>
        {blocker === "locked" ? "locked · unlock" : "session expired · sign in"}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    height: 16,
    paddingHorizontal: 5,
    borderRadius: radius.sm,
    flexShrink: 0,
  },
});
