import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import type { TrashEntityType, TrashItem } from "@companion/core-bridge";
import {
  Button,
  Icon,
  IconButton,
  Spinner,
  Text,
  colors,
  icon,
  layout,
  motion,
  radius,
  row,
  space,
  transition,
  useDensity,
  type IconName,
  type PressState,
} from "@companion/design-system";
import { useCore } from "./CoreContext";
import { ConfirmDialog } from "./ConfirmDialog";

const ENTITY_ICON: Record<TrashEntityType, IconName> = { note: "file", task: "tasks", document: "file", habit: "habits", canvas: "canvas", notebook: "notes" };

export interface TrashScreenProps {
  /** Render the in-page “Empty trash” action. Defaults to on with a pointer and off under
   *  touch density, where the mobile nav bars carry the action (and the title) themselves. */
  emptyAction?: boolean;
}

/** The Trash (PLAN §4.3): notes, tasks, and habits you've deleted, held for 30 days before
 *  they're permanently removed. Each row can be restored or deleted forever. Self-contained
 *  (no navigator dependency) so both the desktop shell and the mobile stack can host it:
 *  a dense list under a 28px header with a pointer, a grouped card of touch rows on a phone. */
export function TrashScreen({ emptyAction }: TrashScreenProps = {}) {
  const { core, trash } = useCore();
  const [items, setItems] = useState<TrashItem[] | null>(null); // null = loading
  const [purgeTarget, setPurgeTarget] = useState<TrashItem | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const touch = useDensity() === "touch";
  const showEmptyAction = emptyAction ?? !touch;

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
  const empty = async () => {
    await trash.empty();
    refresh();
  };

  if (items === null) return <Spinner label="Opening the Trash…" />;

  const dialogs = (
    <>
      {purgeTarget ? (
        <ConfirmDialog
          title="Delete forever?"
          message={`This permanently deletes “${purgeTarget.title || "Untitled"}”. This can’t be undone.`}
          confirmLabel="Delete forever"
          onConfirm={async () => {
            await purge(purgeTarget);
            setPurgeTarget(null);
          }}
          onClose={() => setPurgeTarget(null)}
        />
      ) : null}

      {confirmEmpty ? (
        <ConfirmDialog
          title="Empty the Trash?"
          message={`This permanently deletes all ${items?.length ?? 0} item${(items?.length ?? 0) === 1 ? "" : "s"} in the Trash. This can’t be undone.`}
          confirmLabel="Empty trash"
          onConfirm={async () => {
            await empty();
            setConfirmEmpty(false);
          }}
          onClose={() => setConfirmEmpty(false)}
        />
      ) : null}
    </>
  );

  // Touch: the blurb, then one grouped card of 60px rows with always-visible actions.
  if (touch) {
    return (
      <View style={styles.root}>
        <ScrollView contentContainerStyle={styles.touchPage}>
          <Text tone="tertiary" variant="caption" style={styles.blurb}>
            Deleted notes, tasks, and habits are kept here for 30 days, then permanently removed. Projects and areas
            aren’t trashed — deleting one takes effect immediately.
          </Text>
          {items.length === 0 ? (
            <View style={styles.touchEmpty}>
              <Icon name="trash" size={icon.tile} color={colors.textQuaternary} />
              <Text variant="caption" tone="tertiary">
                The Trash is empty.
              </Text>
            </View>
          ) : (
            <>
              <View style={styles.card}>
                {items.map((it, i) => (
                  <View key={`${it.entityType}:${it.id}`} style={styles.touchRow}>
                    <Icon name={ENTITY_ICON[it.entityType]} size={icon.tile} color={colors.textTertiary} />
                    <View style={[styles.touchRowBody, i === items.length - 1 ? null : styles.rowDivider]}>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text variant="label" numberOfLines={1}>
                          {it.title || "Untitled"}
                        </Text>
                        <Text variant="mono" tone="quaternary" numberOfLines={1}>
                          {it.entityType} · {countdown(it.deletingAt)}
                        </Text>
                      </View>
                      <IconButton label={`Restore ${it.title || "Untitled"}`} onPress={() => void restore(it)}>
                        <Icon name="undo" size={icon.lg} color={colors.textSecondary} />
                      </IconButton>
                      <IconButton label={`Delete ${it.title || "Untitled"} forever`} onPress={() => setPurgeTarget(it)}>
                        <Icon name="trash" size={icon.lg} color={colors.danger} />
                      </IconButton>
                    </View>
                  </View>
                ))}
              </View>
              {showEmptyAction ? <Button label="Empty trash" variant="danger" fullWidth onPress={() => setConfirmEmpty(true)} /> : null}
            </>
          )}
        </ScrollView>
        {dialogs}
      </View>
    );
  }

  // Pointer, nothing deleted: the fact and the rule, centred.
  if (items.length === 0) {
    return (
      <View style={styles.empty}>
        <Icon name="trash" size={icon.tile} color={colors.textQuaternary} />
        <Text variant="caption" tone="tertiary" style={styles.emptyText}>
          Nothing deleted lately. Items stay here 30 days.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text variant="label">Trash</Text>
        <Text variant="mono" tone="quaternary" style={{ flex: 1 }}>
          {items.length} · kept 30 days
        </Text>
        {showEmptyAction ? <Button label="Empty trash" size="sm" variant="danger" onPress={() => setConfirmEmpty(true)} /> : null}
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.list}>
        {items.map((it) => (
          <TrashRow key={`${it.entityType}:${it.id}`} item={it} onRestore={() => void restore(it)} onPurge={() => setPurgeTarget(it)} />
        ))}
      </ScrollView>
      {dialogs}
    </View>
  );
}

/** A dense 24px row: kind icon, title, mono countdown, and restore / delete-forever actions
 *  that only show while the row is hovered (they keep their space, so nothing shifts). */
function TrashRow({ item, onRestore, onPurge }: { item: TrashItem; onRestore: () => void; onPurge: () => void }) {
  const name = item.title || "Untitled";
  return (
    <Pressable
      aria-label={name}
      style={({ hovered }: PressState) => [styles.row, transition("background-color", motion.fast), hovered ? styles.rowHover : null]}
    >
      {({ hovered }: PressState) => (
        <>
          <Icon name={ENTITY_ICON[item.entityType]} size={icon.sm} color={colors.textQuaternary} />
          <Text variant="label" numberOfLines={1} style={styles.rowTitle}>
            {name}
          </Text>
          <Text variant="mono" tone="quaternary" numberOfLines={1}>
            {item.entityType} · {countdown(item.deletingAt)}
          </Text>
          <View style={[styles.rowActions, { opacity: hovered ? 1 : 0 }]}>
            <IconButton label={`Restore ${name}`} size="sm" onPress={onRestore}>
              <Icon name="undo" size={icon.sm} color={colors.textSecondary} />
            </IconButton>
            <IconButton label={`Delete ${name} forever`} size="sm" onPress={onPurge}>
              <Icon name="trash" size={icon.sm} color={colors.danger} />
            </IconButton>
          </View>
        </>
      )}
    </Pressable>
  );
}

/** Mono "time until permanent deletion" from an ISO instant (`deletes in 12d`). */
function countdown(deletingAt?: string | null): string {
  if (!deletingAt) return "scheduled for deletion";
  const ms = new Date(deletingAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return "scheduled for deletion";
  if (ms <= 0) return "deletes any moment";
  const days = Math.ceil(ms / 86_400_000);
  if (days <= 1) return "deletes within 1d";
  return `deletes in ${days}d`;
}

const styles = {
  root: { flex: 1, minHeight: 0 },
  header: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    height: layout.subToolbarH,
    paddingLeft: space.ml,
    paddingRight: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    flexShrink: 0,
  },
  list: { padding: space.xs, gap: 1 },
  row: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.sm,
    minHeight: row.h,
    paddingLeft: space.sm,
    paddingRight: space.xxs,
    borderRadius: radius.sm,
  },
  rowHover: { backgroundColor: colors.surfaceHover },
  rowTitle: { flex: 1, minWidth: 0 },
  rowActions: { flexDirection: "row" as const, alignItems: "center" as const },
  empty: { flex: 1, alignItems: "center" as const, justifyContent: "center" as const, gap: space.md, padding: space.xxl },
  emptyText: { textAlign: "center" as const, maxWidth: 320 },
  // --- touch
  touchPage: { padding: space.xl, gap: space.lg, flexGrow: 1 },
  blurb: { lineHeight: 18 },
  touchEmpty: { flex: 1, alignItems: "center" as const, justifyContent: "center" as const, gap: space.md, paddingVertical: space.huge },
  card: {
    backgroundColor: colors.surfaceCard,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    overflow: "hidden" as const,
  },
  touchRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 14, paddingLeft: 14 },
  touchRowBody: {
    flex: 1,
    minWidth: 0,
    minHeight: 60,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    paddingRight: space.md,
  },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
};
