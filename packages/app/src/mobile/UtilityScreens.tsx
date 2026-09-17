import { useCallback, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Icon, Text, colors, space } from "@companion/design-system";
import { useCore } from "../CoreContext";
import { useNav } from "../nav-context";
import { useNotifications } from "../NotificationsProvider";
import { NotificationsScreen } from "../NotificationsScreen";
import { TrashScreen } from "../TrashScreen";
import { ConfirmDialog } from "../ConfirmDialog";
import { NavAction, NavBar } from "./ui";

// The small routes of the mobile web shell: shared, self-contained screens (Trash,
// Notifications) under a nav bar, and the Habits placeholder. Utility and destructive
// actions are icons in the bar rather than buttons in the content.

/** Habits isn't built yet: the app's own placeholder copy, as a centred caption. */
export function HabitsScreen() {
  return (
    <View style={styles.root}>
      <NavBar title="Habits" />
      <View style={styles.placeholder}>
        <Icon name="habits" size={20} color={colors.textQuaternary} />
        <Text variant="caption" tone="tertiary" style={styles.placeholderText}>
          Habits, streaks, and gentle nudges are on the way.
        </Text>
      </View>
    </View>
  );
}

/** The Trash under a nav bar whose one action empties it. The shared TrashScreen owns the
 * list (restore / delete forever); the bar's action goes through the same core call and
 * the same confirmation. */
export function TrashRouteScreen() {
  const { core, trash } = useCore();
  const [count, setCount] = useState(0);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  // Bumped after emptying so the hosted screen re-reads the (now empty) Trash.
  const [generation, setGeneration] = useState(0);

  const refresh = useCallback(() => {
    void trash.list().then((items) => setCount(items.length));
  }, [trash]);
  useEffect(() => {
    refresh();
    const offNotes = core.on("notes.changed", refresh);
    const offData = core.on("data.changed", refresh);
    return () => {
      offNotes();
      offData();
    };
  }, [core, refresh]);

  return (
    <View style={styles.root}>
      <NavBar
        title="Trash"
        right={<NavAction icon="trash" label="Empty trash" tone="danger" disabled={count === 0} onPress={() => setConfirmEmpty(true)} />}
      />
      <View style={styles.body}>
        <TrashScreen key={generation} />
      </View>
      {confirmEmpty ? (
        <ConfirmDialog
          title="Empty the Trash?"
          message={`This permanently deletes all ${count} item${count === 1 ? "" : "s"} in the Trash. This can’t be undone.`}
          confirmLabel="Empty trash"
          onConfirm={async () => {
            await trash.empty();
            setConfirmEmpty(false);
            setCount(0);
            setGeneration((g) => g + 1);
          }}
          onClose={() => setConfirmEmpty(false)}
        />
      ) : null}
    </View>
  );
}

/** The notifications feed; opening an entry's task pushes its editor. Mark-all-read is
 * the bar's action. */
export function NotificationsRouteScreen() {
  const nav = useNav();
  const { unreadCount, markAllRead } = useNotifications();
  return (
    <View style={styles.root}>
      <NavBar
        title="Notifications"
        right={<NavAction icon="check" label="Mark all read" disabled={unreadCount === 0} onPress={() => void markAllRead()} />}
      />
      <View style={styles.body}>
        <NotificationsScreen onOpenTask={nav.openTask} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceApp },
  body: { flex: 1, minHeight: 0 },
  placeholder: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.md, padding: space.xxl },
  placeholderText: { textAlign: "center", maxWidth: 320, lineHeight: 18 },
});
