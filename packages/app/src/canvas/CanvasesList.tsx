import { useContext, useEffect, useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import type { Canvas } from "@companion/core-bridge";
import { Icon, IconButton, Input, ListRow, Spinner, Text, colors, icon, space } from "@companion/design-system";
import { ListFilterMenu } from "../ListFilterMenu";
import { timeAgo } from "../NotificationRow";
import { DragHandle } from "../DndContext";
import { useCanvases } from "./CanvasesProvider";
import { pressMods, useOptionalMultiSelect } from "../MultiSelectProvider";
import { NavContext } from "../nav-context";

/** The canvases browse column, shared by the root Canvases view and a project's Canvases
 *  section. Root mode filters Unsorted/All like the notes list; project mode takes the
 *  project's member boards and shows a back affordance. A dense list like notes: 24px rows
 *  (44 under touch density, via ListRow) with the edit time as mono trailing metadata. */
export function CanvasesList({
  canvases,
  selectedId,
  onSelect,
  onCreate,
  onBack,
  title,
  scope = "canvases",
}: {
  /** Project mode: the boards to show. Omit for root mode (the store's filtered list). */
  canvases?: Canvas[];
  selectedId?: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  /** Project mode: back to the section menu. */
  onBack?: () => void;
  title?: string;
  /** Names this list to the multiselect (cmd/shift-click, as in the notes and tasks lists): a
   *  project's list passes its own, so switching lists drops the selection. */
  scope?: string;
}) {
  const store = useCanvases();
  const ms = useOptionalMultiSelect();
  const navVisible = useContext(NavContext)?.visible ?? true;
  const [query, setQuery] = useState("");
  const source = canvases ?? store.visible;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return source;
    return source.filter((c) => c.name.toLowerCase().includes(q));
  }, [source, query]);

  // Announce this list and its visible order so range-select matches the screen. Only while
  // its tab is the one showing — background tabs stay mounted and would fight for the scope.
  const register = ms?.register;
  useEffect(() => {
    if (!navVisible) return;
    register?.(scope, "canvas", filtered.map((c) => c.id));
  }, [register, scope, filtered, navVisible]);

  if (!canvases && store.loading) return <Spinner label="Loading your canvases…" />;

  return (
    <View style={styles.list}>
      <View style={styles.listHeader}>
        {onBack ? (
          <IconButton label="Back to sections" size="sm" onPress={onBack}>
            <Icon name="chevronLeft" size={icon.sm} color={colors.textSecondary} />
          </IconButton>
        ) : null}
        {canvases ? (
          <Text variant="label" numberOfLines={1} style={{ flex: 1 }}>
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
        <Text variant="mono" tone="quaternary">
          {source.length}
        </Text>
        <IconButton label="New canvas" size="sm" onPress={onCreate}>
          <Icon name="plus" size={icon.sm} color={colors.textSecondary} />
        </IconButton>
      </View>
      <View style={styles.search}>
        <Input size="sm" placeholder="Search canvases" value={query} onChangeText={setQuery} leadingIcon={<Icon name="search" size={icon.sm} color={colors.textQuaternary} />} />
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.scroll}>
        {filtered.length ? (
          filtered.map((c) => {
            const selected = ms?.active ? ms.isSelected(c.id) : c.id === selectedId;
            // The grip drags the board onto a project/area in the sidebar, like the note and task rows.
            return (
              <ListRow
                key={c.id}
                accessory={<DragHandle payload={{ kind: "canvas", id: c.id, label: c.name || "Untitled canvas" }} />}
                icon={<Icon name="canvas" size={icon.sm} color={selected ? colors.textAccent : colors.textQuaternary} />}
                title={c.name || "Untitled canvas"}
                trailing={timeAgo(c.updatedAt)}
                selected={selected}
                onPress={(e) => {
                  if (!ms?.press(c.id, pressMods(e))) onSelect(c.id);
                }}
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
    gap: space.sm,
    minHeight: 32,
    paddingLeft: space.sm,
    paddingRight: space.sm,
    paddingTop: space.sm,
    paddingBottom: space.xs,
    // Above the search row, so the filter dropdown paints over the input beneath it.
    zIndex: 2,
  },
  search: { paddingHorizontal: space.sm, paddingBottom: space.sm, zIndex: 1 },
  scroll: { padding: space.xs, gap: 1 },
  empty: { padding: space.xl, lineHeight: 18, textAlign: "center" as const },
};
