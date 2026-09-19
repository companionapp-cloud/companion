import { StyleSheet, View } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import { colors } from "@companion/design-system";
import { ListFilterTabs } from "../ListFilterMenu";
import { useProjects } from "../ProjectsProvider";
import { NotesListScreen, TasksListScreen } from "./ListScreens";
import { ListsIndexScreen, ListRowsScreen } from "./ListsScreens";
import { CanvasesListScreen } from "./CanvasScreens";
import { ProjectCalendarScreen } from "./CalendarScreens";
import { NavBar } from "./ui";
import { useToolVisibility } from "../ToolVisibilityProvider";

// A project's scoped view for the mobile web shell: a Notes/Tasks/Lists/Canvases/Calendar
// switcher over the shared list screens, each filtered to the project's members (PLAN §6.6).
// The native app uses a bottom tab bar; a segmented control in the nav bar does the same job
// here without pulling in another navigator. The section lives in the route, so the URL
// names it and Back from a drilled-in list lands on the tab it left.

type Section = "notes" | "tasks" | "lists" | "canvases" | "calendars";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NavLike = any;

export function ProjectScreen() {
  const navigation = useNavigation<NavLike>();
  const params = (useRoute().params ?? {}) as { projectId?: string; section?: string; itemId?: string };
  const { projects } = useProjects();
  // Hiding the Calendar tool in Settings › Tools drops the tab, as it drops the desktop chip.
  const calendarShown = !useToolVisibility().hidden.has("calendar");
  const projectId = params.projectId ?? "";
  const section: Section =
    params.section === "tasks"
      ? "tasks"
      : params.section === "lists"
        ? "lists"
        : params.section === "canvases"
          ? "canvases"
          : params.section === "calendars" && calendarShown
            ? "calendars"
            : "notes";

  if (!projectId) return null;

  // /project/<id>/lists/<listId> drills into one list's rows (it brings its own nav bar).
  if (params.section === "lists" && params.itemId) {
    return (
      <View style={styles.root}>
        <ListRowsScreen key={params.itemId} projectId={projectId} listId={params.itemId} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <NavBar
        title={projects.find((p) => p.id === projectId)?.name ?? "Project"}
        segments={
          <ListFilterTabs
            value={section}
            onChange={(next: Section) => navigation.setParams({ section: next })}
            options={[
              { value: "notes", label: "Notes" },
              { value: "tasks", label: "Tasks" },
              { value: "lists", label: "Lists" },
              { value: "canvases", label: "Canvases" },
              ...(calendarShown ? [{ value: "calendars" as const, label: "Calendar" }] : []),
            ]}
          />
        }
      />
      {section === "notes" ? (
        <NotesListScreen key={projectId} projectId={projectId} />
      ) : section === "calendars" ? (
        <ProjectCalendarScreen key={projectId} projectId={projectId} />
      ) : section === "lists" ? (
        <ListsIndexScreen key={projectId} projectId={projectId} />
      ) : section === "canvases" ? (
        <CanvasesListScreen key={projectId} projectId={projectId} />
      ) : (
        <TasksListScreen key={projectId} projectId={projectId} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceApp },
});
