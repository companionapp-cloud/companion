import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import type { Area, Canvas, Note, Project, ProjectMember, Task } from "@companion/core-bridge";
import type { DocumentSource } from "@companion/editor";
import { Button, Icon, ListRow, Text, colors, control, icon, radius, space, type PressState } from "@companion/design-system";
import { useNav, type ContainerRef, type ProjectSection } from "./nav-context";
import { useProjects } from "./ProjectsProvider";
import { useTasks } from "./TasksProvider";
import { filterBySchedule, scheduleDate, withoutSomeday, type ScheduleFilter } from "./taskSchedule";
import { TaskRow } from "./TaskEditor";
import { DeleteProjectDialog } from "./DeleteProjectDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { timeAgo } from "./NotificationRow";
import { ContainerOverview, OverviewCard, OVERVIEW_LIMIT } from "./ContainerOverview";
import { DragHandle } from "./DndContext";
import { ProjectSchedule } from "./ProjectSchedule";

/** A container's tasks-list filter. "unsorted" exists only in an area: the tasks filed directly
 *  in it, in none of its projects. */
export type TaskListFilter = "all" | "unsorted" | ScheduleFilter;

const byUpdated = <T extends { updatedAt: string }>(items: T[]) => [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
const bySchedule = (items: Task[]) => [...items].sort((a, b) => (scheduleDate(a)?.getTime() ?? 0) - (scheduleDate(b)?.getTime() ?? 0));

/** The overview a project or an area opens on (PLAN-areas.md §3): its page — cover, emoji, name,
 * description — then up to ten rows each of what matters in it, with "View all" into the
 * matching section, and its settings at the foot.
 *
 * A project shows its recently updated tasks, upcoming tasks, recently updated notes and
 * canvases. An area shows its projects, its unsorted tasks (filed in the area itself, in none of
 * its projects), and the upcoming tasks and notes of the whole area — its projects' included. */
export function ContainerHome({
  container,
  page,
  notes,
  tasks,
  canvases,
  members,
  projectOf,
  sections,
  onViewTasks,
  onOpenTask,
  documentSource,
}: {
  container: ContainerRef;
  page: Project | Area;
  notes: Note[];
  tasks: Task[];
  canvases: Canvas[];
  members: ProjectMember[];
  projectOf: Map<string, string>;
  /** The sections on offer (a tool hidden in Settings drops its cards too). */
  sections: ProjectSection[];
  onViewTasks: (filter: TaskListFilter) => void;
  /** Where a task row opens, for a host that isn't the container's own page (the Logbook's
   *  split view keeps it in its pane). Defaults to the container's tasks section. */
  onOpenTask?: (id: string) => void;
  /** The mobile shell's document source, where the context has none. */
  documentSource?: DocumentSource;
}) {
  const nav = useNav();
  const tasksStore = useTasks();
  const { sidebar, areas, projectById, updateProject, updateArea, deleteProject, deleteArea } = useProjects();
  const project = container.kind === "project" ? projectById(container.id) : undefined;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const inArea = container.kind === "area";
  const update = (fields: Parameters<typeof updateArea>[1]) =>
    void (inArea ? updateArea(container.id, fields) : updateProject(container.id, fields));

  // An area rolls up its projects' tasks; the ones in a Someday project are filed away with it.
  const filedAway = inArea ? tasksStore.somedayIds : undefined;
  const openTasks = useMemo(() => withoutSomeday(tasks, filedAway).filter((t) => t.status !== "done"), [tasks, filedAway]);
  const upcoming = useMemo(() => bySchedule(filterBySchedule(tasks, "upcoming", filedAway)), [tasks, filedAway]);
  const recentTasks = useMemo(() => byUpdated(openTasks), [openTasks]);
  const completed = !!project?.completedAt;
  const doneTasks = useMemo(
    () => tasks.filter((t) => t.status === "done").sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? "")),
    [tasks],
  );
  const unsorted = useMemo(() => {
    const direct = new Set(members.filter((m) => m.containerType === "area").map((m) => m.entityId));
    return byUpdated(openTasks.filter((t) => direct.has(t.id)));
  }, [members, openTasks]);
  const recentNotes = useMemo(() => byUpdated(notes), [notes]);
  const recentCanvases = useMemo(() => byUpdated(canvases), [canvases]);
  // Active projects first, the Someday ones after them.
  const areaProjects = useMemo(() => {
    const all = inArea ? (sidebar.areas.find((a) => a.id === container.id)?.projects ?? []) : [];
    return [...all.filter((p) => !p.someday), ...all.filter((p) => p.someday)];
  }, [sidebar, inArea, container.id]);
  const has = (s: ProjectSection) => sections.includes(s);

  const taskRows = (rows: Task[]) =>
    rows.slice(0, OVERVIEW_LIMIT).map((t) => (
      // The grip drags the task onto another project/area in the sidebar (absent on mobile).
      <TaskRow
        key={t.id}
        handle={<DragHandle payload={{ kind: "task", id: t.id, label: t.title || "Untitled task" }} />}
        task={t}
        onPress={() => (onOpenTask ? onOpenTask(t.id) : nav.openContainer(container, "tasks", t.id))}
        onToggle={() => void tasksStore.setStatus(t.id, t.status === "done" ? "open" : "done")}
        trailing={projectOf.has(t.id) ? <Text variant="mono" tone="quaternary" numberOfLines={1}>{projectOf.get(t.id)}</Text> : undefined}
      />
    ));

  return (
    <>
      <ContainerOverview
        key={container.id}
        name={page.name}
        namePlaceholder={inArea ? "Area name" : "Project name"}
        icon={page.icon}
        color={page.color}
        coverDocumentId={page.coverDocumentId}
        descriptionMd={page.descriptionMd ?? ""}
        onRename={(name) => update({ name })}
        onUpdatePage={update}
        documentSource={documentSource}
        meta={project ? <ProjectSchedule project={project} openTasks={tasks.filter((t) => t.status === "open").length} /> : undefined}
        onOpenRef={(ref) => {
          // A chip opens its target in a new tab, leaving the page put.
          if (ref.type === "task" || ref.type === "note") nav.openInNewTab({ kind: ref.type, id: ref.id });
          else if (ref.type === "canvas") nav.openCanvas(ref.id);
          else if (ref.type === "project") nav.openProject(ref.id);
        }}
        footer={
          <>
            {!inArea ? (
              <>
                <Text variant="eyebrow" tone="quaternary">
                  Area
                </Text>
                <View style={styles.chips}>
                  {areas.map((a) => {
                    const on = a.id === (page as Project).areaId;
                    return (
                      <Pressable
                        key={a.id}
                        onPress={() => void updateProject(container.id, { areaId: a.id })}
                        aria-label={a.name}
                        style={({ hovered, pressed }: PressState) => [
                          styles.chip,
                          styles.areaChip,
                          on ? styles.areaChipOn : { backgroundColor: pressed ? colors.surfaceActive : hovered ? colors.surfaceHover : "transparent" },
                        ]}
                      >
                        <Text variant="caption" tone={on ? "accent" : "secondary"}>
                          {a.icon ? `${a.icon} ${a.name}` : a.name}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </>
            ) : null}
            <View style={styles.footer}>
              {inArea && areaProjects.length > 0 ? (
                <Text variant="caption" tone="tertiary">
                  An area can be deleted once it has no projects.
                </Text>
              ) : (
                <Button label={inArea ? "Delete area" : "Delete project"} variant="danger" size="sm" onPress={() => setConfirmDelete(true)} />
              )}
            </View>
          </>
        }
      >
        {inArea ? (
          <OverviewCard title="Projects" count={areaProjects.length} empty="No projects in this area yet. Add one with ＋ beside the area in the sidebar.">
            {areaProjects.map((p) => (
              <ListRow
                key={p.id}
                icon={p.icon ? <Text style={styles.rowEmoji}>{p.icon}</Text> : <Icon name="folder" size={icon.sm} color={p.color ?? colors.textQuaternary} />}
                title={p.name}
                // A Someday project is off the sidebar; this card is where it lives (PLAN-scheduling.md §1).
                trailing={p.someday ? "Someday" : p.taskProgress != null ? `${Math.round(p.taskProgress * 100)}%` : undefined}
                onPress={() => nav.openProject(p.id)}
              />
            ))}
          </OverviewCard>
        ) : null}
        {has("tasks") && inArea ? (
          <OverviewCard
            title="Unsorted tasks"
            count={unsorted.length}
            empty="Tasks filed in this area, outside its projects, show up here."
            onViewAll={() => onViewTasks("unsorted")}
          >
            {taskRows(unsorted)}
          </OverviewCard>
        ) : null}
        {/* A completed project (open from the Logbook) has nothing left to do: its page looks
            back at what was done instead (PLAN-scheduling.md §6). */}
        {has("tasks") && completed ? (
          <OverviewCard title="Completed tasks" count={doneTasks.length} empty="No tasks were completed in this project." onViewAll={() => onViewTasks("all")}>
            {taskRows(doneTasks)}
          </OverviewCard>
        ) : null}
        {has("tasks") && !inArea && !completed ? (
          <OverviewCard title="Recently updated tasks" count={recentTasks.length} empty="No open tasks in this project." onViewAll={() => onViewTasks("all")}>
            {taskRows(recentTasks)}
          </OverviewCard>
        ) : null}
        {has("tasks") && !completed ? (
          <OverviewCard
            title="Upcoming tasks"
            count={upcoming.length}
            empty={`Nothing with a deadline ahead in this ${container.kind}.`}
            onViewAll={() => onViewTasks("upcoming")}
          >
            {taskRows(upcoming)}
          </OverviewCard>
        ) : null}
        {has("notes") ? (
          <OverviewCard
            title={inArea ? "Notes" : "Recently updated notes"}
            count={recentNotes.length}
            empty={`No notes in this ${container.kind} yet.`}
            onViewAll={() => nav.openContainer(container, "notes")}
          >
            {recentNotes.slice(0, OVERVIEW_LIMIT).map((n) => (
              <ListRow
                key={n.id}
                accessory={<DragHandle payload={{ kind: "note", id: n.id, label: n.title || "Untitled" }} />}
                icon={<Icon name={n.date ? "today" : "file"} size={icon.sm} color={colors.textQuaternary} />}
                title={n.title || "Untitled"}
                subtitle={projectOf.get(n.id)}
                trailing={timeAgo(n.updatedAt)}
                onPress={() => nav.openContainer(container, "notes", n.id)}
              />
            ))}
          </OverviewCard>
        ) : null}
        {has("canvases") && !inArea ? (
          <OverviewCard
            title="Recently updated canvases"
            count={recentCanvases.length}
            empty="No canvases in this project yet."
            onViewAll={() => nav.openContainer(container, "canvases")}
          >
            {recentCanvases.slice(0, OVERVIEW_LIMIT).map((c) => (
              <ListRow
                key={c.id}
                accessory={<DragHandle payload={{ kind: "canvas", id: c.id, label: c.name || "Untitled canvas" }} />}
                icon={<Icon name="canvas" size={icon.sm} color={colors.textQuaternary} />}
                title={c.name || "Untitled canvas"}
                trailing={timeAgo(c.updatedAt)}
                onPress={() => nav.openContainer(container, "canvases", c.id)}
              />
            ))}
          </OverviewCard>
        ) : null}
      </ContainerOverview>

      {confirmDelete && !inArea ? (
        <DeleteProjectDialog
          projectName={page.name}
          onConfirm={async (deleteContent) => {
            await deleteProject(container.id, deleteContent);
            nav.back();
          }}
          onClose={() => setConfirmDelete(false)}
        />
      ) : null}
      {confirmDelete && inArea ? (
        <ConfirmDialog
          title="Delete area?"
          message={`Delete the area “${page.name}”? Anything filed directly in it moves to Unsorted.`}
          confirmLabel="Delete area"
          onConfirm={async () => {
            await deleteArea(container.id);
            nav.back();
          }}
          onClose={() => setConfirmDelete(false)}
        />
      ) : null}
    </>
  );
}

const styles = {
  chip: { flexDirection: "row" as const, alignItems: "center" as const, gap: 5, height: control.sm, paddingHorizontal: 7, borderRadius: radius.sm },
  chips: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: space.xs },
  // Area choices are bordered chips (a pick-one set).
  areaChip: { borderWidth: 1, borderColor: colors.borderSubtle, paddingHorizontal: 6 },
  areaChipOn: { borderColor: colors.accentSoftBorder, backgroundColor: colors.accentSoft },
  // Emoji sit in an icon's slot; pin the line box so a row never grows around one.
  rowEmoji: { fontSize: 12, lineHeight: 16, width: icon.sm + 2, textAlign: "center" as const },
  footer: { flexDirection: "row" as const, marginTop: space.md },
};
