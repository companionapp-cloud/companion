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
import { useToolVisibility, type ToolId } from "../ToolVisibilityProvider";
import { ContainerHome } from "../ContainerHome";
import { useContainerContent } from "../useContainerContent";
import { useNav, type ContainerRef, type ProjectSection } from "../nav-context";

// A project's — and an area's — page for the mobile web shell: an Overview tab (the cover,
// emoji, description and cards of PLAN-areas.md §3) then a Notes/Tasks/Lists/Canvases/Calendar
// switcher over the shared list screens, each filtered to the container's members (PLAN §6.6).
// The native app uses a bottom tab bar; a segmented control in the nav bar does the same job
// here without pulling in another navigator. The section lives in the route, so the URL
// names it and Back from a drilled-in list lands on the tab it left.

type Section = "overview" | "notes" | "tasks" | "lists" | "canvases" | "calendars";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NavLike = any;

export function ProjectScreen() {
  const navigation = useNavigation<NavLike>();
  const params = (useRoute().params ?? {}) as { projectId?: string; section?: string; itemId?: string };
  const { projectById } = useProjects();
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
            : params.section === "notes"
              ? "notes"
              : "overview";

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
        title={projectById(projectId)?.name ?? "Project"}
        segments={
          <ListFilterTabs
            value={section}
            anchorPrefix="page.section."
            onChange={(next: Section) => navigation.setParams({ section: next === "overview" ? undefined : next })}
            options={[
              { value: "overview", label: "Overview" },
              { value: "notes", label: "Notes" },
              { value: "tasks", label: "Tasks" },
              { value: "lists", label: "Lists" },
              { value: "canvases", label: "Canvases" },
              ...(calendarShown ? [{ value: "calendars" as const, label: "Calendar" }] : []),
            ]}
          />
        }
      />
      {section === "overview" ? (
        <ContainerOverviewTab key={projectId} container={{ kind: "project", id: projectId }} />
      ) : section === "notes" ? (
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

/** An area's page: Overview, then the three things an area holds directly — notes, tasks and
 *  canvases, never lists or calendars (PLAN-areas.md §2). Each list rolls up the area's
 *  projects' content too, and files what it creates in the area itself. */
export function AreaScreen() {
  const navigation = useNavigation<NavLike>();
  const params = (useRoute().params ?? {}) as { areaId?: string; section?: string };
  const { areas } = useProjects();
  const { hidden } = useToolVisibility();
  const areaId = params.areaId ?? "";
  const tabs = AREA_TABS.filter((t) => !t.tool || !hidden.has(t.tool));
  const section = tabs.find((t) => t.value === params.section)?.value ?? "overview";

  if (!areaId) return null;
  const area = areas.find((a) => a.id === areaId);

  return (
    <View style={styles.root}>
      <NavBar
        title={area ? (area.icon ? `${area.icon} ${area.name}` : area.name) : "Area"}
        segments={
          <ListFilterTabs
            value={section}
            anchorPrefix="page.section."
            onChange={(next: AreaTab) => navigation.setParams({ section: next === "overview" ? undefined : next })}
            options={tabs.map((t) => ({ value: t.value, label: t.label }))}
          />
        }
      />
      {section === "overview" ? (
        <ContainerOverviewTab key={areaId} container={{ kind: "area", id: areaId }} />
      ) : section === "notes" ? (
        <NotesListScreen key={areaId} areaId={areaId} />
      ) : section === "canvases" ? (
        <CanvasesListScreen key={areaId} areaId={areaId} />
      ) : (
        <TasksListScreen key={areaId} areaId={areaId} />
      )}
    </View>
  );
}

type AreaTab = "overview" | "notes" | "tasks" | "canvases";
const AREA_TABS: { value: AreaTab; label: string; tool?: ToolId }[] = [
  { value: "overview", label: "Overview" },
  { value: "notes", label: "Notes", tool: "notes" },
  { value: "tasks", label: "Tasks", tool: "tasks" },
  { value: "canvases", label: "Canvases", tool: "canvases" },
];

/** The Overview tab: the same page the desktop shows, at touch density. */
function ContainerOverviewTab({ container }: { container: ContainerRef }) {
  const nav = useNav();
  const { areas, projectById } = useProjects();
  const { hidden } = useToolVisibility();
  const content = useContainerContent(container);
  const page = container.kind === "area" ? areas.find((a) => a.id === container.id) : projectById(container.id);
  if (!page) return null;
  const sections = (["notes", "tasks", "canvases"] as ProjectSection[]).filter((s) => !hidden.has(s as ToolId));
  return (
    <ContainerHome
      container={container}
      page={page}
      notes={content.notes}
      tasks={content.tasks}
      canvases={content.canvases}
      members={content.members}
      projectOf={content.projectOf}
      sections={sections}
      onViewTasks={() => nav.openContainer(container, "tasks")}
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceApp },
});
