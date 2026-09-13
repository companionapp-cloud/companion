import { useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import type { GraphNode } from "@companion/core-bridge";
import { Icon, IconButton, Input, ListRow, Text, colors, radius, shadow, space } from "@companion/design-system";
import { useCore } from "../CoreContext";

/** A search dialog for choosing a note or task to embed on a canvas. Backed by the same
 *  graph search the editor's `[[` autocomplete uses. Resolves through onPick / onClose. */
export function RefPicker({ type, onPick, onClose }: { type: "note" | "task"; onPick: (node: GraphNode) => void; onClose: () => void }) {
  const { graph } = useCore();
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
          <Text variant="title">{type === "note" ? "Add a note" : "Add a task"}</Text>
          <View style={{ flex: 1 }} />
          <IconButton label="Close" size="sm" onPress={onClose}>
            <Icon name="close" size={16} color={colors.textSecondary} />
          </IconButton>
        </View>
        <View style={styles.search}>
          <Input
            size="sm"
            autoFocus
            placeholder={type === "note" ? "Search notes" : "Search tasks"}
            value={query}
            onChangeText={setQuery}
            leadingIcon={<Icon name="search" size={15} color={colors.textTertiary} />}
          />
        </View>
        <ScrollView contentContainerStyle={styles.body}>
          {results.length ? (
            results.map((n) => (
              <ListRow
                key={n.id}
                icon={<Icon name={type === "note" ? "file" : "tasks"} size={16} color={colors.textTertiary} />}
                title={n.title || "Untitled"}
                onPress={() => onPick(n)}
              />
            ))
          ) : (
            <Text tone="tertiary" variant="caption" style={{ padding: space.lg, textAlign: "center" }}>
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
  scrimFill: { position: "absolute" as const, top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "rgba(17,17,16,0.25)" },
  card: { width: 420, maxWidth: "92%" as const, maxHeight: "80%" as const, backgroundColor: colors.surfaceCard, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.borderSubtle, ...shadow.lg, overflow: "hidden" as const },
  header: { flexDirection: "row" as const, alignItems: "center" as const, paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  search: { padding: space.md },
  body: { padding: space.sm, gap: 2 },
};
