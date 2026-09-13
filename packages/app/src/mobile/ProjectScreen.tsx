import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useRoute } from "@react-navigation/native";
import { colors, space } from "@companion/design-system";
import { ListFilterTabs } from "../ListFilterMenu";
import { NotesListScreen, TasksListScreen } from "./ListScreens";
import { ListsIndexScreen, ListRowsScreen } from "./ListsScreens";

// A project's scoped view for the mobile web shell: a Notes/Tasks switcher over the
// shared list screens, each filtered to the project's members (PLAN §6.6). The native
// app uses a bottom tab bar; a segmented control does the same job here without pulling
// in another navigator. The shell header shows the project name.
export function ProjectScreen() {
  const params = (useRoute().params ?? {}) as { projectId?: string; section?: string; itemId?: string };
  const projectId = params.projectId ?? "";
  const [section, setSection] = useState<"notes" | "tasks" | "lists">(
    params.section === "tasks" ? "tasks" : params.section === "lists" ? "lists" : "notes",
  );

  if (!projectId) return null;

  // /project/<id>/lists/<listId> drills into one list's rows (its own back returns here).
  if (params.section === "lists" && params.itemId) {
    return (
      <View style={styles.root}>
        <ListRowsScreen key={params.itemId} projectId={projectId} listId={params.itemId} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.tabs}>
        <ListFilterTabs
          value={section}
          onChange={setSection}
          options={[
            { value: "notes", label: "Notes" },
            { value: "tasks", label: "Tasks" },
            { value: "lists", label: "Lists" },
          ]}
        />
      </View>
      {section === "notes" ? (
        <NotesListScreen key={projectId} projectId={projectId} />
      ) : section === "lists" ? (
        <ListsIndexScreen key={projectId} projectId={projectId} />
      ) : (
        <TasksListScreen key={projectId} projectId={projectId} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceApp },
  tabs: { paddingHorizontal: space.md, paddingTop: space.sm },
});
