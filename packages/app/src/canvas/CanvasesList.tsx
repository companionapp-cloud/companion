import { useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import type { Canvas } from "@companion/core-bridge";
import { Icon, IconButton, Input, ListRow, Spinner, Text, colors, space } from "@companion/design-system";
import { ListFilterMenu } from "../ListFilterMenu";
import { timeAgo } from "../NotificationRow";
import { useCanvases } from "./CanvasesProvider";

/** The canvases browse column, shared by the root Canvases view and a project's Canvases
 *  section. Root mode filters Unsorted/All like the notes list; project mode takes the
 *  project's member boards and shows a back affordance. */
export function CanvasesList({
  canvases,
  selectedId,
  onSelect,
  onCreate,
  onBack,
  title,
}: {
  /** Project mode: the boards to show. Omit for root mode (the store's filtered list). */
  canvases?: Canvas[];
  selectedId?: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  /** Project mode: back to the section menu. */
  onBack?: () => void;
  title?: string;
}) {
  const store = useCanvases();
  const [query, setQuery] = useState("");
  const source = canvases ?? store.visible;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return source;
    return source.filter((c) => c.name.toLowerCase().includes(q));
  }, [source, query]);

  if (!canvases && store.loading) return <Spinner label="Loading your canvases…" />;

  return (
    <View style={styles.list}>
      <View style={styles.listHeader}>
        {onBack ? (
          <IconButton label="Back to sections" size="sm" onPress={onBack}>
            <Icon name="chevronLeft" size={18} color={colors.textSecondary} />
          </IconButton>
        ) : null}
        {canvases ? (
          <Text variant="caption" tone="secondary" style={{ flex: 1, fontWeight: "600" }}>
            {title ?? "Canvases"}
          </Text>
        ) : (
          <View style={{ flex: 1 }}>
            <ListFilterMenu
              value={store.filter}
              onChange={store.setFilter}
              options={[
                { value: "all", label: "All canvases" },
                { value: "unsorted", label: "Unsorted canvases" },
              ]}
            />
          </View>
        )}
        <Text variant="mono" tone="tertiary">
          {source.length}
        </Text>
        <IconButton label="New canvas" size="sm" onPress={onCreate}>
          <Icon name="plus" size={16} color={colors.textSecondary} />
        </IconButton>
      </View>
      <View style={styles.search}>
        <Input size="sm" placeholder="Search canvases" value={query} onChangeText={setQuery} leadingIcon={<Icon name="search" size={15} color={colors.textTertiary} />} />
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: space.md, gap: 2 }}>
        {filtered.length ? (
          filtered.map((c) => {
            const selected = c.id === selectedId;
            return (
              <ListRow
                key={c.id}
                icon={<Icon name="canvas" size={17} color={selected ? colors.accentHover : colors.textTertiary} />}
                title={c.name || "Untitled canvas"}
                subtitle={`Edited ${timeAgo(c.updatedAt)}`}
                selected={selected}
                onPress={() => onSelect(c.id)}
              />
            );
          })
        ) : (
          <Text tone="tertiary" variant="caption" style={styles.empty}>
            {query ? "No canvases match that." : "No canvases yet. Add one with ＋ — a board for arranging notes, tasks, and ideas spatially."}
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

const styles = {
  list: { flex: 1, minHeight: 0, backgroundColor: colors.surfaceCard },
  listHeader: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.xs,
    minHeight: 28 + space.md * 2 + 1,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    zIndex: 2,
  },
  search: { paddingHorizontal: space.md, paddingTop: space.md, paddingBottom: space.md, zIndex: 1 },
  empty: { padding: space.xl, lineHeight: 20, textAlign: "center" as const },
};
