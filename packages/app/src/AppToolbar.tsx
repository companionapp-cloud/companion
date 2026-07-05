import { Pressable, ScrollView, View } from "react-native";
import { Icon, IconButton, Tab, Toolbar, colors, space } from "@companion/design-system";
import { useNav } from "./nav-context";
import { useNotes } from "./NotesProvider";

/** The app's top toolbar: back/forward history, open-note tabs, and the section-level
 * action (New). Note-scoped actions (pop-out, delete, sync) live in the note view's
 * own sub-toolbar. */
export function AppToolbar() {
  const nav = useNav();
  const store = useNotes();

  const inNotes = nav.current.kind === "notes" || nav.current.kind === "note";
  const noteId = nav.current.kind === "note" ? nav.current.id : null;

  const onCreate = async () => {
    const note = await store.create();
    nav.openNote(note.id);
  };

  return (
    <Toolbar>
      <IconButton label="Back" size="sm" disabled={!nav.canBack} onPress={nav.back}>
        <Icon name="chevronLeft" size={18} color={colors.textSecondary} />
      </IconButton>
      <IconButton label="Forward" size="sm" disabled={!nav.canForward} onPress={nav.forward}>
        <Icon name="chevronRight" size={18} color={colors.textSecondary} />
      </IconButton>

      <View style={separator} />

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flex: 1 }}
        contentContainerStyle={{ flexGrow: 1, alignItems: "center", gap: space.xs }}
      >
        {nav.tabs.map((id) => (
          <Tab
            key={id}
            label={store.byId(id)?.title || "Untitled"}
            active={noteId === id}
            onPress={() => nav.openNote(id)}
            onClose={() => nav.closeTab(id)}
          />
        ))}
        {/* Empty toolbar space deselects the active note. */}
        <Pressable onPress={nav.deselect} style={{ flex: 1, alignSelf: "stretch", cursor: "auto" }} aria-label="Deselect note" />
      </ScrollView>

      {/* section action */}
      {inNotes ? (
        <IconButton label="New note" onPress={onCreate}>
          <Icon name="plus" color={colors.textSecondary} />
        </IconButton>
      ) : null}
    </Toolbar>
  );
}

const separator = { width: 1, height: 20, marginHorizontal: space.xs, backgroundColor: colors.borderSubtle };
