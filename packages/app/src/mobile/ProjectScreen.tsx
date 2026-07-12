import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useRoute } from "@react-navigation/native";
import { colors, space } from "@companion/design-system";
import { ListFilterTabs } from "../ListFilterMenu";
import { NotesListScreen, TasksListScreen } from "./ListScreens";

// A project's scoped view for the mobile web shell: a Notes/Tasks switcher over the
// shared list screens, each filtered to the project's members (PLAN §6.6). The native
// app uses a bottom tab bar; a segmented control does the same job here without pulling
// in another navigator. The shell header shows the project name.
export function ProjectScreen() {
  const params = (useRoute().params ?? {}) as { projectId?: string; section?: string };
  const projectId = params.projectId ?? "";
  const [section, setSection] = useState<"notes" | "tasks">(params.section === "tasks" ? "tasks" : "notes");

  if (!projectId) return null;

  return (
    <View style={styles.root}>
      <View style={styles.tabs}>
        <ListFilterTabs
          value={section}
          onChange={setSection}
          options={[
            { value: "notes", label: "Notes" },
            { value: "tasks", label: "Tasks" },
          ]}
        />
      </View>
      {section === "notes" ? (
        <NotesListScreen key={projectId} projectId={projectId} />
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
