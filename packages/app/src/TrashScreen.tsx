import { useCallback, useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import type { TrashEntityType, TrashItem } from "@companion/core-bridge";
import {
  Button,
  Icon,
  Spinner,
  Text,
  colors,
  layout,
  radius,
  space,
  type IconName,
} from "@companion/design-system";
import { useCore } from "./CoreContext";
import { ConfirmDialog } from "./ConfirmDialog";

const ENTITY_ICON: Record<TrashEntityType, IconName> = { note: "file", task: "tasks", document: "file", habit: "habits" };
const ENTITY_LABEL: Record<TrashEntityType, string> = { note: "Note", task: "Task", document: "Document", habit: "Habit" };

/** The Trash (PLAN §4.3): notes, tasks, and habits you've deleted, held for 30 days before
 *  they're permanently removed. Each row can be restored or deleted forever. Self-contained
 *  (no navigator dependency) so both the desktop shell and the mobile stack can host it. */
export function TrashScreen() {
  const { core, trash } = useCore();
  const [items, setItems] = useState<TrashItem[] | null>(null); // null = loading
  const [purgeTarget, setPurgeTarget] = useState<TrashItem | null>(null);

  const refresh = useCallback(() => {
    void trash.list().then(setItems);
  }, [trash]);

  useEffect(() => {
    refresh();
    // Trash contents change on any note mutation (local trash/restore/purge or a synced
    // change from another device), so refresh on the same signals every screen listens to.
    const offNotes = core.on("notes.changed", refresh);
    const offData = core.on("data.changed", refresh);
    return () => {
      offNotes();
      offData();
    };
  }, [core, refresh]);

  const restore = async (it: TrashItem) => {
    await trash.restore(it.entityType, it.id);
    refresh();
  };
  const purge = async (it: TrashItem) => {
    await trash.purge(it.entityType, it.id);
    refresh();
  };

  if (items === null) return <Spinner label="Opening the Trash…" />;

  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={styles.page}>
        <Text variant="title">Trash</Text>
        <Text tone="tertiary" variant="caption" style={styles.blurb}>
          Deleted notes, tasks, and habits are kept here for 30 days, then permanently removed.
          Projects and areas aren’t trashed — deleting one takes effect immediately.
        </Text>

        {items.length === 0 ? (
          <View style={styles.empty}>
            <Icon name="trash" size={28} color={colors.textTertiary} />
            <Text tone="tertiary" style={{ marginTop: space.md }}>
              The Trash is empty.
            </Text>
          </View>
        ) : (
          <View style={styles.card}>
            {items.map((it, i) => (
              <View key={`${it.entityType}:${it.id}`} style={[styles.row, i === items.length - 1 ? null : styles.rowDivider]}>
                <Icon name={ENTITY_ICON[it.entityType]} size={18} color={colors.textTertiary} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1}>{it.title || "Untitled"}</Text>
                  <Text variant="caption" tone="tertiary" numberOfLines={1}>
                    {ENTITY_LABEL[it.entityType]} · {countdown(it.deletingAt)}
                  </Text>
                </View>
                <Button label="Restore" size="sm" variant="secondary" onPress={() => void restore(it)} />
                <Button label="Delete forever" size="sm" variant="danger" onPress={() => setPurgeTarget(it)} />
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      {purgeTarget ? (
        <ConfirmDialog
          title="Delete forever?"
          message={`This permanently deletes “${purgeTarget.title || "Untitled"}”. This can’t be undone.`}
          confirmLabel="Delete forever"
          onConfirm={async () => {
            await purge(purgeTarget);
          }}
          onClose={() => setPurgeTarget(null)}
        />
      ) : null}
    </View>
  );
}

/** Human "time until permanent deletion" from an ISO instant. */
function countdown(deletingAt?: string | null): string {
  if (!deletingAt) return "scheduled for deletion";
  const ms = new Date(deletingAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return "scheduled for deletion";
  if (ms <= 0) return "deletes any moment now";
  const days = Math.ceil(ms / 86_400_000);
  if (days <= 1) return "deletes within a day";
  return `deletes in ${days} days`;
}

const styles = {
  page: { maxWidth: layout.contentMax, width: "100%" as const, marginHorizontal: "auto" as const, padding: space.xxl, gap: space.md },
  blurb: { lineHeight: 18, marginBottom: space.md },
  empty: { alignItems: "center" as const, paddingVertical: space.xxxl },
  card: {
    backgroundColor: colors.surfaceCard,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    overflow: "hidden" as const,
  },
  row: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
};
