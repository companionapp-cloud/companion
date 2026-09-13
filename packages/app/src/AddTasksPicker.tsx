import { useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import type { Task } from "@companion/core-bridge";
import { Button, Icon, IconButton, Input, Text, colors, radius, shadow, space, type PressState } from "@companion/design-system";
import { Checkbox } from "./TaskEditor";
import { Overlay } from "./Overlay";

/** A modal picker that adds existing project tasks to a list (the "Add from this project"
 *  action). Multi-select with a search filter; confirming adds every checked task in one
 *  call. Styled to match BulkAssignPicker / ConfirmDialog. */
export function AddTasksPicker({
  candidates,
  onAdd,
  onClose,
}: {
  /** Tasks eligible to be added (the project's open tasks not already in the list). */
  candidates: Task[];
  onAdd: (taskIds: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? candidates.filter((t) => t.title.toLowerCase().includes(q)) : candidates;
  }, [candidates, query]);

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const confirm = async () => {
    if (busy || picked.size === 0) return;
    setBusy(true);
    try {
      await onAdd([...picked]);
      onClose();
    } catch {
      setBusy(false);
    }
  };

  return (
    <Overlay>
    <View style={styles.scrim}>
      <Pressable style={styles.scrimFill} onPress={onClose} aria-label="Close" />
      <View style={styles.card}>
        <View style={styles.header}>
          <Text variant="title">Add from this project</Text>
          <View style={{ flex: 1 }} />
          <IconButton label="Close" size="sm" onPress={onClose}>
            <Icon name="close" size={16} color={colors.textSecondary} />
          </IconButton>
        </View>
        <Text tone="tertiary" variant="caption" style={styles.subtitle}>
          {candidates.length ? "Pick the tasks to append to this list." : "Every open task in this project is already in this list."}
        </Text>
        {candidates.length > 6 ? (
          <View style={styles.search}>
            <Input
              size="sm"
              placeholder="Search tasks"
              value={query}
              onChangeText={setQuery}
              autoFocus
              leadingIcon={<Icon name="search" size={15} color={colors.textTertiary} />}
            />
          </View>
        ) : null}
        <ScrollView contentContainerStyle={styles.body}>
          {shown.length === 0 && candidates.length > 0 ? (
            <Text tone="tertiary" variant="caption" style={{ padding: space.md }}>
              No tasks match that.
            </Text>
          ) : (
            shown.map((t) => {
              const on = picked.has(t.id);
              return (
                <Pressable
                  key={t.id}
                  onPress={() => toggle(t.id)}
                  disabled={busy}
                  style={({ hovered }: PressState) => [styles.row, on ? styles.rowOn : hovered ? { backgroundColor: colors.surfaceHover } : null]}
                >
                  <Checkbox checked={on} onPress={() => toggle(t.id)} size={18} label={on ? "Deselect" : "Select"} />
                  <Text style={{ flex: 1 }} numberOfLines={1}>
                    {t.title || "Untitled task"}
                  </Text>
                </Pressable>
              );
            })
          )}
        </ScrollView>
        <View style={styles.footer}>
          <Button label="Cancel" variant="ghost" onPress={onClose} />
          <Button
            label={picked.size > 1 ? `Add ${picked.size} tasks` : "Add task"}
            variant="primary"
            disabled={busy || picked.size === 0}
            onPress={() => void confirm()}
          />
        </View>
      </View>
    </View>
    </Overlay>
  );
}

const styles = {
  scrim: {
    // On web the Overlay portals this to document.body, so `fixed` pins it to the viewport
    // above every pane and toolbar; native has no fixed positioning and covers its screen.
    position: (Platform.OS === "web" ? "fixed" : "absolute") as "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    backgroundColor: "rgba(17,17,16,0.28)",
    zIndex: 1000,
  },
  scrimFill: { position: "absolute" as const, top: 0, left: 0, right: 0, bottom: 0 },
  card: {
    width: 420,
    maxWidth: "92%" as const,
    maxHeight: "80%" as const,
    backgroundColor: colors.surfaceCard,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    ...shadow.lg,
    overflow: "hidden" as const,
  },
  header: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    paddingHorizontal: space.xl,
    paddingTop: space.lg,
    paddingBottom: space.sm,
  },
  subtitle: { paddingHorizontal: space.xl, paddingBottom: space.md },
  search: { paddingHorizontal: space.md, paddingBottom: space.sm },
  body: { padding: space.md, gap: 2 },
  row: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
  },
  rowOn: { backgroundColor: colors.accentSoft },
  footer: {
    flexDirection: "row" as const,
    justifyContent: "flex-end" as const,
    gap: space.sm,
    padding: space.md,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
  },
};
