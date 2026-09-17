import { useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import type { GraphNode } from "@companion/core-bridge";
import { Icon, IconButton, Input, ListRow, Text, colors, icon, layout, radius, shadow, space, useDensity } from "@companion/design-system";
import { useCore } from "../CoreContext";

/** A search dialog for choosing a note or task to embed on a canvas. Backed by the same
 *  graph search the editor's `[[` autocomplete uses. Resolves through onPick / onClose. */
export function RefPicker({ type, onPick, onClose }: { type: "note" | "task"; onPick: (node: GraphNode) => void; onClose: () => void }) {
  const { graph } = useCore();
  // Desktop density is for pointers; under touch the controls fall back to their 30px default.
  const touch = useDensity() === "touch";
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GraphNode[]>([]);

  useEffect(() => {
    let cancelled = false;
    void graph.search(query, type, 30).then((rows) => {
      if (!cancelled) setResults(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [graph, query, type]);

  return (
    <View style={styles.scrim}>
      <Pressable style={styles.scrimFill} onPress={onClose} aria-label="Close" />
      <View style={styles.card}>
        <View style={styles.header}>
          <Text variant="label">{type === "note" ? "Add a note" : "Add a task"}</Text>
          <View style={{ flex: 1 }} />
          <IconButton label="Close" size={touch ? undefined : "sm"} onPress={onClose}>
            <Icon name="close" size={icon.sm} color={colors.textSecondary} />
          </IconButton>
        </View>
        <View style={styles.search}>
          <Input
            size={touch ? undefined : "sm"}
            autoFocus
            placeholder={type === "note" ? "Search notes" : "Search tasks"}
            value={query}
            onChangeText={setQuery}
            leadingIcon={<Icon name="search" size={icon.sm} color={colors.textQuaternary} />}
          />
        </View>
        <ScrollView contentContainerStyle={styles.body}>
          {results.length ? (
            results.map((n) => (
              <ListRow
                key={n.id}
                icon={<Icon name={type === "note" ? "file" : "tasks"} size={icon.sm} color={colors.textQuaternary} />}
                title={n.title || "Untitled"}
                onPress={() => onPick(n)}
              />
            ))
          ) : (
            <Text tone="tertiary" variant="caption" style={styles.empty}>
              {query ? "Nothing matches that." : `No ${type}s yet.`}
            </Text>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = {
  scrim: { position: "absolute" as const, top: 0, right: 0, bottom: 0, left: 0, alignItems: "center" as const, justifyContent: "center" as const, zIndex: 50 },
  scrimFill: { position: "absolute" as const, top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.scrim },
  // A floating picker, not a dialog: overlay surface, hairline, 6px radius, the menu shadow.
  card: { width: 420, maxWidth: "92%" as const, maxHeight: "80%" as const, backgroundColor: colors.surfaceOverlay, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.borderSubtle, ...shadow.md, overflow: "hidden" as const },
  header: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm, minHeight: layout.subToolbarH, paddingLeft: space.ml, paddingRight: space.xs, borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  search: { padding: space.sm },
  body: { paddingHorizontal: space.xs, paddingBottom: space.xs, gap: 1 },
  empty: { padding: space.lg, textAlign: "center" as const, lineHeight: 18 },
};
