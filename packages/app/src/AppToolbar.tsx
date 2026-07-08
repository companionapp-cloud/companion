import { ScrollView, View } from "react-native";
import { Icon, IconButton, Tab, Toolbar, colors, space } from "@companion/design-system";
import { useNav } from "./nav-context";
import { useNotes } from "./NotesProvider";
import { useTasks } from "./TasksProvider";
import { NotificationsBell } from "./NotificationsBell";
import { Draggable } from "./DndContext";

/** The app's top toolbar: back/forward history, the shared workspace tab strip (notes and
 * tasks together — each tab is a document or empty), a "+" to add a tab, and the
 * section-level New action. Per-tab expand pops the document out to its own window. */
export function AppToolbar() {
  const nav = useNav();
  const notes = useNotes();
  const tasks = useTasks();

  const inNotes = nav.current.kind === "notes";
  const inTasks = nav.current.kind === "tasks";

  const labelFor = (kind: "note" | "task", id: string) => {
    const title = kind === "note" ? notes.byId(id)?.title : tasks.byId(id)?.title;
    return title || "Untitled";
  };

  const onCreate = async () => {
    if (inTasks) {
      const task = await tasks.create({ title: "Untitled task" });
      nav.openTask(task.id);
    } else {
      const note = await notes.create();
      nav.openNote(note.id);
    }
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
        {nav.tabs.map((tab, i) => {
          const ref = tab.ref;
          const el = (
            <Tab
              label={ref ? labelFor(ref.kind, ref.id) : "Nothing selected"}
              active={i === nav.activeIndex}
              icon={ref ? <Icon name={ref.kind === "task" ? "tasks" : "file"} size={13} color={colors.textTertiary} /> : undefined}
              onPress={() => nav.selectTab(i)}
              onExpand={ref ? () => nav.expandTab(i) : undefined}
              onClose={() => nav.closeTab(i)}
            />
          );
          // A tab holding a document can be dragged onto a project to add it there.
          return ref ? (
            <Draggable key={tab.uid} payload={{ kind: ref.kind, id: ref.id, label: labelFor(ref.kind, ref.id) }}>
              {el}
            </Draggable>
          ) : (
            <View key={tab.uid}>{el}</View>
          );
        })}
        <IconButton label="New tab" size="sm" onPress={nav.addTab}>
          <Icon name="plus" size={15} color={colors.textTertiary} />
        </IconButton>
        {/* Fills the remaining toolbar width (also a desktop window drag handle). */}
        <View style={{ flex: 1, alignSelf: "stretch" }} />
      </ScrollView>

      <NotificationsBell />
      {inNotes || inTasks ? (
        <IconButton label={inTasks ? "New task" : "New note"} onPress={onCreate}>
          <Icon name="plus" color={colors.textSecondary} />
        </IconButton>
      ) : null}
    </Toolbar>
  );
}

const separator = { width: 1, height: 20, marginHorizontal: space.xs, backgroundColor: colors.borderSubtle };
