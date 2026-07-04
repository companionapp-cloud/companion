import { useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import type { Note } from "@companion/core-bridge";
import { Center, Icon, Input, ListRow, SplitView, Spinner, Text, colors, layout, space } from "@companion/design-system";
import { useNav } from "./nav-context";
import { useNotes } from "./NotesProvider";
import { NoteEditor } from "./NoteEditor";
import { openNoteWindow } from "./focus";

/** The Notes splitview (list → document editor). Rendered inside the Frame card by
 * AppShell; navigation and data come from the Navigator + NotesProvider. */
export function NotesScreen({ activeNoteId }: { activeNoteId: string | null }) {
  const store = useNotes();
  const nav = useNav();
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return store.notes;
    return store.notes.filter(
      (n) => n.title.toLowerCase().includes(q) || n.contentMd.toLowerCase().includes(q),
    );
  }, [store.notes, query]);

  const active = activeNoteId ? store.byId(activeNoteId) : null;

  const onPopOut = (id: string) => {
    openNoteWindow(id);
    nav.closeTab(id);
  };
  const onDelete = async (id: string) => {
    await store.remove(id);
    nav.closeTab(id);
  };

  if (store.loading) {
    return <Spinner label="Loading your notes…" />;
  }

  return (
    <SplitView
      storageKey="companion.notes.listWidth"
      defaultWidth={layout.listW}
      minWidth={240}
      maxWidth={480}
      aside={
        <View style={styles.list}>
          <View style={styles.listHeader}>
            <Text variant="caption" tone="secondary" style={{ flex: 1, fontWeight: "600" }}>
              All notes
            </Text>
            <Text variant="mono" tone="tertiary">
              {store.notes.length}
            </Text>
          </View>
          <View style={styles.search}>
            <Input
              size="sm"
              placeholder="Search notes"
              value={query}
              onChangeText={setQuery}
              leadingIcon={<Icon name="search" size={15} color={colors.textTertiary} />}
            />
          </View>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: space.md, gap: 2 }}>
            {filtered.length ? (
              filtered.map((n) => (
                <ListRow
                  key={n.id}
                  icon={<Icon name="file" size={17} color={n.id === activeNoteId ? colors.accentHover : colors.textTertiary} />}
                  title={n.title || "Untitled"}
                  subtitle={preview(n)}
                  selected={n.id === activeNoteId}
                  onPress={() => nav.openNote(n.id)}
                />
              ))
            ) : (
              <Text tone="tertiary" variant="caption" style={styles.empty}>
                {query ? "No notes match that." : "Nothing here yet. A blank page is just potential, etc."}
              </Text>
            )}
          </ScrollView>
        </View>
      }
    >
      {/* DETAIL */}
      <View style={styles.detail}>
        {active ? (
          <NoteEditor key={active.id} note={active} onChange={store.save} onPopOut={onPopOut} onDelete={onDelete} />
        ) : (
          <Center>
            <Text tone="tertiary">Select a note, or start a new one.</Text>
          </Center>
        )}
      </View>
    </SplitView>
  );
}

function preview(n: Note): string {
  const body = n.contentMd.replace(/\s+/g, " ").trim();
  return body || "No additional text";
}

const styles = {
  list: {
    flex: 1,
    minHeight: 0,
    backgroundColor: colors.surfaceCard,
  },
  listHeader: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.md,
  },
  search: { paddingHorizontal: space.md, paddingBottom: space.md },
  empty: { padding: space.xxl, textAlign: "center" as const, lineHeight: 20 },
  detail: { flex: 1, minWidth: 0, backgroundColor: colors.surfaceCard },
};
