import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
import type { Area, Canvas, Note, Project, ProjectMember, RepeatingTask, Task } from "@companion/core-bridge";
import {
  Center,
  Icon,
  IconButton,
  Input,
  ListRow,
  ProgressRing,
  SplitView,
  Text,
  colors,
  control,
  icon,
  layout,
  motion,
  radius,
  space,
  transition,
  type PressState,
} from "@companion/design-system";
import { containerOfLocation, useNav, type ContainerRef, type ProjectSection } from "./nav-context";
import { useToolVisibility, type ToolId } from "./ToolVisibilityProvider";
import { useProjects } from "./ProjectsProvider";
import { useNotes } from "./NotesProvider";
import { useTasks, filterTasksByDue } from "./TasksProvider";
import { ListFilterMenu } from "./ListFilterMenu";
import { ListSectionFold } from "./ListSectionFold";
import { NoteEditor } from "./NoteEditor";
import { TaskEditor, TaskRow } from "./TaskEditor";
import { repeatSubtitle } from "./repeat";
import { useMultiSelect, pressMods } from "./MultiSelectProvider";
import { SelectionStack } from "./SelectionStack";
import { MultiSelectBar } from "./MultiSelectBar";
import { ListsColumn, ListHome, listStyles } from "./ProjectLists";
import { EmptyDetail } from "./WorkspaceScreen";
import { timeAgo } from "./NotificationRow";
import { useProjectLists } from "./ListsProvider";
import { useCanvases } from "./canvas/CanvasesProvider";
import { CanvasesList } from "./canvas/CanvasesList";
import { CanvasPane } from "./canvas/CanvasPane";
import { CalendarScreen } from "./CalendarScreen";
import { ProjectCalendarsColumn } from "./ProjectCalendars";
import { ContainerHome, type TaskListFilter } from "./ContainerHome";
import { useContainerContent } from "./useContainerContent";

const SECTIONS: { id: ProjectSection; label: string; tool: ToolId }[] = [
  { id: "notes", label: "Notes", tool: "notes" },
  { id: "tasks", label: "Tasks", tool: "tasks" },
  // Lists order a project's tasks, so they follow the Tasks tool's visibility.
  { id: "lists", label: "Lists", tool: "tasks" },
  { id: "canvases", label: "Canvases", tool: "canvases" },
  { id: "calendars", label: "Calendars", tool: "calendar" },
  { id: "habits", label: "Habits", tool: "habits" },
];
const SECTION_LABEL: Record<ProjectSection, string> = { notes: "Notes", tasks: "Tasks", lists: "Lists", canvases: "Canvases", calendars: "Calendars", habits: "Habits" };
/** An area holds notes, tasks and canvases — never lists or calendars (PLAN-areas.md §2). */
const AREA_SECTIONS = new Set<ProjectSection>(["notes", "tasks", "canvases"]);

/** The page a project — or an area — opens on (PLAN §6.6, PLAN-areas.md §3), rendered in the
 * main content area (not a modal): a 32px header (icon, name, task progress), a toolbar of
 * chips — Overview, then the container's sections — and under it either the full-width
 * overview page or a split of that section's dense list beside the selected item's editor.
 * Nothing is selected on the user's behalf — a section opens on the empty state, and
 * switching section drops the selection. Every level is a deep-linkable URL:
 * /project/<id>[/<section>[/<itemId>]] and /area/<id>[/<section>[/<itemId>]]; the bare URL is
 * the overview.
 *
 * An area's sections roll up: they list what is filed directly in the area AND what its
 * projects hold (each such row names its project), the same set its overview summarizes. */
export function ProjectView() {
  const nav = useNav();
  const { projects, areas } = useProjects();
  // Hiding a tool in Settings › Tools also drops its section from the chips.
  const { hidden } = useToolVisibility();
  const loc = nav.current;
  const container = containerOfLocation(loc);
  const containerKind = container?.kind;
  const containerId = container?.id ?? "";
  // Lives here, not in the list column, so an overview card's "View all" can open the tasks
  // section already narrowed (unsorted, upcoming).
  const [taskFilter, setTaskFilter] = useState<TaskListFilter>("all");

  const { members, notes, tasks, seeds, canvases, projectOf } = useContainerContent(container);

  const projectLists = useProjectLists(containerKind === "project" ? containerId : "");
  // Calendars filed in the project: single calendars and whole accounts.
  const calendarCount = useMemo(
    () => members.filter((m) => m.entityType === "calendar" || m.entityType === "calendar_account").length,
    [members],
  );

  if (!container) return null;
  const page: Project | Area | undefined =
    container.kind === "area" ? areas.find((a) => a.id === container.id) : projects.find((p) => p.id === container.id);
  if (!page) {
    return (
      <Center>
        <Text tone="tertiary">This {container.kind} is gone.</Text>
      </Center>
    );
  }

  const sections = SECTIONS.filter((s) => !hidden.has(s.tool) && (container.kind === "project" || AREA_SECTIONS.has(s.id)));
  // No section in the URL is the overview page.
  const section: ProjectSection | undefined = sections.some((s) => s.id === container.section) ? container.section : undefined;
  const doneCount = tasks.filter((t) => t.status === "done").length;
  // The tasks chip counts what's left to do, not everything ever added to the project.
  const counts: Partial<Record<ProjectSection, number>> = {
    notes: notes.length,
    tasks: tasks.length - doneCount,
    lists: projectLists.length,
    canvases: canvases.length,
    calendars: calendarCount,
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        {page.icon ? (
          <Text style={styles.headerEmoji}>{page.icon}</Text>
        ) : (
          <Icon name="folder" size={icon.md} color={page.color ?? colors.textSecondary} />
        )}
        <Text variant="title" numberOfLines={1} style={{ flexShrink: 1 }}>
          {page.name}
        </Text>
        {tasks.length ? (
          <>
            <ProgressRing value={doneCount / tasks.length} />
            <Text variant="mono" tone="quaternary">
              {doneCount}/{tasks.length} done
            </Text>
          </>
        ) : null}
      </View>

      <View style={styles.chipRow}>
        <SectionChip label="Overview" selected={!section} onPress={() => section && nav.openContainer(container)} />
        {sections.map((s) => (
          <SectionChip
            key={s.id}
            label={s.label}
            count={counts[s.id]}
            selected={s.id === section}
            onPress={() => {
              // Re-picking the open section keeps its selection; a different one clears it.
              if (s.id === section) return;
              setTaskFilter("all");
              nav.openContainer(container, s.id);
            }}
          />
        ))}
      </View>

      {!section ? (
        <ContainerHome
          container={container}
          page={page}
          notes={notes}
          tasks={tasks}
          canvases={canvases}
          members={members}
          projectOf={projectOf}
          sections={sections.map((s) => s.id)}
          onViewTasks={(filter) => {
            setTaskFilter(filter);
            nav.openContainer(container, "tasks");
          }}
        />
      ) : (
        <SplitView
          storageKey="companion.project.listWidth"
          defaultWidth={layout.listW}
          minWidth={200}
          maxWidth={440}
          aside={
            <ListColumn
              container={container}
              section={section}
              notes={notes}
              tasks={tasks}
              seeds={seeds}
              canvases={canvases}
              members={members}
              projectOf={projectOf}
              taskFilter={taskFilter}
              onTaskFilter={setTaskFilter}
            />
          }
        >
          <DetailPane container={container} section={section} />
        </SplitView>
      )}
    </View>
  );
}

/** One section chip: 22px, radius 3, caption label + mono count. Selected reads like a
 *  selected row (soft fill, accent text); hover steps the fill, nothing moves. */
function SectionChip({ label, count, selected, onPress }: { label: string; count?: number; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      aria-label={label}
      style={({ hovered, pressed }: PressState) => [
        styles.chip,
        transition("background-color", motion.instant),
        { backgroundColor: selected ? colors.surfaceSelected : pressed ? colors.surfaceActive : hovered ? colors.surfaceHover : "transparent" },
      ]}
    >
      <Text variant="caption" tone={selected ? "accent" : "secondary"}>
        {label}
      </Text>
      {count != null ? (
        <Text variant="mono" tone={selected ? "accent" : "quaternary"}>
          {count}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** The list column: the open section's dense browse list (the chips above pick which). */
function ListColumn({
  container,
  section,
  notes,
  tasks,
  seeds,
  canvases,
  members,
  projectOf,
  taskFilter,
  onTaskFilter: setTaskFilter,
}: {
  container: ContainerRef & { itemId?: string; subItemId?: string };
  section: ProjectSection;
  notes: Note[];
  tasks: Task[];
  seeds: RepeatingTask[];
  canvases: Canvas[];
  members: ProjectMember[];
  /** In an area: the project each rolled-up item lives in, by entity id. */
  projectOf: Map<string, string>;
  taskFilter: TaskListFilter;
  onTaskFilter: (filter: TaskListFilter) => void;
}) {
  const nav = useNav();
  const notesStore = useNotes();
  const tasksStore = useTasks();
  const canvasesStore = useCanvases();
  const { addMember, addAreaMember } = useProjects();
  const ms = useMultiSelect();
  const inArea = container.kind === "area";
  const where = inArea ? "area" : "project";
  // New content is filed where it was made: in the project, or directly in the area.
  const file = (entityType: "note" | "task" | "canvas", id: string) =>
    inArea ? addAreaMember(container.id, entityType, id) : addMember(container.id, entityType, id);

  // Per-section list controls: a search box narrows the notes list, a filter narrows the
  // tasks list (all / unsorted / upcoming / overdue).
  const [noteQuery, setNoteQuery] = useState("");
  // The project's lists, so the tasks header dropdown can jump straight into one.
  const projectLists = useProjectLists(inArea ? "" : container.id);
  const [taskDraft, setTaskDraft] = useState("");
  // The tasks filed directly in the area — in none of its projects (PLAN-areas.md §3).
  const directIds = useMemo(
    () => new Set(members.filter((m) => m.containerType === "area").map((m) => m.entityId)),
    [members],
  );
  const filteredNotes = useMemo(() => {
    const q = noteQuery.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter((n) => n.title.toLowerCase().includes(q) || n.contentMd.toLowerCase().includes(q));
  }, [notes, noteQuery]);
  const filteredTasks = useMemo(() => {
    if (taskFilter === "all") return tasks;
    if (taskFilter === "unsorted") return tasks.filter((t) => directIds.has(t.id));
    return filterTasksByDue(tasks, taskFilter);
  }, [tasks, taskFilter, directIds]);
  // Completed tasks drop to their own section at the bottom, as in the root task list (§6.4).
  const openTasks = useMemo(() => filteredTasks.filter((t) => t.status !== "done"), [filteredTasks]);
  const doneTasks = useMemo(() => filteredTasks.filter((t) => t.status === "done"), [filteredTasks]);

  // Register the on-screen section list for multiselect (notes / actionable tasks; seeds
  // stay single-select). Scoped per project+section so switching lists drops the selection.
  // Registers the filtered order so range-select matches what's shown. Only while this tab
  // is the one on screen — background tabs stay mounted and would fight for the scope.
  const scope = `${container.kind}:${container.id}`;
  const secSection = section;
  useEffect(() => {
    if (!nav.visible) return;
    if (secSection === "notes") ms.register(`${scope}:notes`, "note", filteredNotes.map((n) => n.id));
    else if (secSection === "tasks") ms.register(`${scope}:tasks`, "task", [...openTasks, ...doneTasks].map((t) => t.id));
  }, [ms.register, scope, secSection, filteredNotes, openTasks, doneTasks, nav.visible]);

  const projectId = container.id;
  const { itemId, subItemId } = container;
  const openItem = (sec: ProjectSection, id: string) => nav.openContainer(container, sec, id);

  // The lists section has its own column (index of lists → one list's rows).
  if (section === "lists") {
    return <ListsColumn projectId={projectId} listId={itemId} selectedTaskId={subItemId} projectTasks={tasks} />;
  }
  // Calendars: the ones the project holds; the grid beside them is the project's calendar.
  if (section === "calendars") {
    return <ProjectCalendarsColumn projectId={projectId} />;
  }
  // Canvases: the project's member boards (PLAN-canvases.md); a new board joins the project.
  if (section === "canvases") {
    return (
      <CanvasesList
        canvases={canvases}
        selectedId={itemId ?? null}
        onSelect={(id) => openItem("canvases", id)}
        onCreate={() => {
          void (async () => {
            const c = await canvasesStore.create();
            await file("canvas", c.id);
            openItem("canvases", c.id);
          })();
        }}
      />
    );
  }

  const createNoteInProject = async () => {
    const note = await notesStore.create();
    await file("note", note.id);
    openItem("notes", note.id);
  };
  const createTaskInProject = async (title?: string) => {
    const task = await tasksStore.create({ title: title?.trim() || "Untitled task" });
    await file("task", task.id);
    openItem("tasks", task.id);
  };
  const addTaskFromDraft = async () => {
    const title = taskDraft;
    setTaskDraft("");
    await createTaskInProject(title);
  };

  const count = section === "notes" ? notes.length : section === "tasks" ? openTasks.length : null;

  return (
    <View style={styles.list}>
      <View style={styles.listHeader}>
        {/* The tasks section swaps the static title for its due-date filter, matching the
            root task list; other sections keep the plain label. */}
        {section === "tasks" ? (
          <View style={{ flex: 1 }}>
            <ListFilterMenu<TaskListFilter | `list:${string}`>
              value={taskFilter}
              onChange={(v) => {
                // List entries jump into that list's ordered view; the rest filter in place.
                if (v.startsWith("list:")) nav.openProjectItem(projectId, "lists", v.slice(5));
                else setTaskFilter(v as TaskListFilter);
              }}
              options={[
                { value: "all", label: "All tasks" },
                // An area's own tasks, as opposed to the ones its projects hold.
                ...(inArea ? [{ value: "unsorted" as const, label: "Unsorted tasks" }] : []),
                { value: "upcoming", label: "Upcoming tasks" },
                { value: "overdue", label: "Overdue tasks" },
                ...projectLists.map((l) => ({ value: `list:${l.id}` as const, label: `List: ${l.name}` })),
              ]}
            />
          </View>
        ) : (
          <Text variant="label" numberOfLines={1} style={{ flex: 1 }}>
            {SECTION_LABEL[section]}
          </Text>
        )}
        {count != null ? (
          <Text variant="mono" tone="quaternary">
            {count}
          </Text>
        ) : null}
        {section === "notes" ? (
          <IconButton label="New note" size="sm" onPress={createNoteInProject}>
            <Icon name="plus" size={icon.sm} color={colors.textSecondary} />
          </IconButton>
        ) : section === "tasks" ? (
          <IconButton label="New task" size="sm" onPress={() => void createTaskInProject()}>
            <Icon name="plus" size={icon.sm} color={colors.textSecondary} />
          </IconButton>
        ) : null}
      </View>
      {section === "notes" ? (
        <View style={styles.search}>
          <Input
            size="sm"
            placeholder="Search notes"
            value={noteQuery}
            onChangeText={setNoteQuery}
            leadingIcon={<Icon name="search" size={icon.sm} color={colors.textQuaternary} />}
          />
        </View>
      ) : section === "tasks" ? (
        <View style={styles.search}>
          <Input
            size="sm"
            placeholder="Add a task, press Enter"
            value={taskDraft}
            onChangeText={setTaskDraft}
            onSubmitEditing={() => void addTaskFromDraft()}
            leadingIcon={<Icon name="plus" size={icon.sm} color={colors.textQuaternary} />}
          />
        </View>
      ) : null}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.scroll}>
        {section === "notes" ? (
          filteredNotes.length ? (
            filteredNotes.map((n) => {
              const selected = ms.active ? ms.isSelected(n.id) : n.id === itemId;
              return (
                <ListRow
                  key={n.id}
                  icon={<Icon name={n.date ? "today" : "file"} size={icon.sm} color={selected ? colors.textAccent : colors.textQuaternary} />}
                  title={n.title || "Untitled"}
                  subtitle={projectOf.get(n.id)}
                  trailing={timeAgo(n.updatedAt)}
                  selected={selected}
                  onPress={(e) => {
                    if (!ms.press(n.id, pressMods(e))) openItem("notes", n.id);
                  }}
                />
              );
            })
          ) : (
            <Text tone="tertiary" variant="caption" style={styles.empty}>
              {noteQuery
                ? "No notes match that."
                : "No notes yet. Add one with ＋, or move existing notes here from a note’s “Move to” menu."}
            </Text>
          )
        ) : section === "tasks" ? (
          filteredTasks.length || (taskFilter === "all" && seeds.length) ? (
            <>
              {openTasks.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  selected={ms.active ? ms.isSelected(t.id) : t.id === itemId}
                  onPress={(e) => {
                    if (!ms.press(t.id, pressMods(e))) openItem("tasks", t.id);
                  }}
                  onToggle={() => void tasksStore.setStatus(t.id, "done")}
                />
              ))}
              {/* Repeating definitions have no concrete due date, so hide them under a due filter. */}
              {taskFilter === "all" && seeds.length ? (
                <ListSectionFold label={`Repeating · ${seeds.length}`} storageKey="tasks.repeating" defaultOpen>
                  {seeds.map((s) => (
                    <ListRow
                      key={s.id}
                      icon={<Icon name="repeat" size={icon.sm} color={s.id === itemId ? colors.textAccent : colors.textQuaternary} />}
                      title={s.title || "Untitled task"}
                      subtitle={repeatSubtitle(s.repeatRule, s.nextOccurrence)}
                      selected={s.id === itemId}
                      onPress={() => openItem("tasks", s.id)}
                    />
                  ))}
                </ListSectionFold>
              ) : null}
              {doneTasks.length ? (
                <ListSectionFold label={`Completed · ${doneTasks.length}`} storageKey="tasks.completed" defaultOpen={false}>
                  {doneTasks.map((t) => (
                    <TaskRow
                      key={t.id}
                      task={t}
                      selected={ms.active ? ms.isSelected(t.id) : t.id === itemId}
                      onPress={(e) => {
                        if (!ms.press(t.id, pressMods(e))) openItem("tasks", t.id);
                      }}
                      onToggle={() => void tasksStore.setStatus(t.id, "open")}
                    />
                  ))}
                </ListSectionFold>
              ) : null}
            </>
          ) : (
            <Text tone="tertiary" variant="caption" style={styles.empty}>
              {taskFilter === "upcoming"
                ? `No upcoming tasks in this ${where}.`
                : taskFilter === "overdue"
                  ? `No overdue tasks in this ${where}.`
                  : taskFilter === "unsorted"
                    ? "Every task in this area belongs to one of its projects."
                    : "No tasks yet. Add one with ＋, or move existing tasks here from a task’s “Move to” menu."}
            </Text>
          )
        ) : (
          <Text tone="tertiary" variant="caption" style={styles.empty}>
            {SECTION_LABEL[section]} for this {where} arrive in a later milestone.
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

/** The detail pane: the selected note, task, list or canvas — or the empty state. Nothing
 * is picked on the user's behalf. */
function DetailPane({ container, section }: { container: ContainerRef & { itemId?: string; subItemId?: string }; section: ProjectSection }) {
  const nav = useNav();
  const notesStore = useNotes();
  const tasksStore = useTasks();
  const ms = useMultiSelect();
  const { itemId, subItemId } = container;

  // A multiselection takes over the detail pane: the bulk sub-toolbar + the selection stack
  // showing the first selected item, instead of the single-item editor.
  if (ms.active && nav.visible) {
    const id = ms.primaryId;
    let body: ReactNode = <Center><Text tone="tertiary">Nothing to preview.</Text></Center>;
    if (id && ms.kind === "note") {
      const note = notesStore.byId(id);
      if (note) body = <NoteEditor key={note.id} note={note} onChange={notesStore.save} />;
    } else if (id && ms.kind === "task") {
      const task = tasksStore.byId(id) ?? tasksStore.seedById(id);
      if (task) body = <TaskEditor key={task.id} task={task} save={tasksStore.update} />;
    }
    return (
      <View style={styles.detail}>
        <MultiSelectBar />
        <SelectionStack count={ms.count}>{body}</SelectionStack>
      </View>
    );
  }

  if (section === "notes" && itemId) {
    const note = notesStore.byId(itemId);
    if (!note) {
      return (
        <Center>
          <Text tone="tertiary">This note is gone.</Text>
        </Center>
      );
    }
    return (
      <NoteEditor
        key={note.id}
        note={note}
        onChange={notesStore.save}
        onPopOut={(id) => nav.openInNewTab({ kind: "note", id })}
        onDelete={async (id) => {
          await notesStore.remove(id);
          nav.openContainer(container, "notes");
        }}
      />
    );
  }

  if (section === "tasks" && itemId) {
    const task = tasksStore.byId(itemId) ?? tasksStore.seedById(itemId);
    if (!task) {
      return (
        <Center>
          <Text tone="tertiary">This task is gone.</Text>
        </Center>
      );
    }
    return (
      <TaskEditor
        key={task.id}
        task={task}
        save={tasksStore.update}
        onPopOut={(id) => nav.openInNewTab({ kind: "task", id })}
        onDelete={async (id) => {
          await tasksStore.remove(id);
          nav.openContainer(container, "tasks");
        }}
      />
    );
  }

  // A task selected inside a list opens here, exactly like one selected in the tasks
  // section; closing/deleting it returns to the list.
  if (section === "lists" && itemId && subItemId) {
    const task = tasksStore.byId(subItemId);
    if (!task) {
      return (
        <Center>
          <Text tone="tertiary">This task is gone.</Text>
        </Center>
      );
    }
    return (
      <TaskEditor
        key={task.id}
        task={task}
        save={tasksStore.update}
        onPopOut={(id) => nav.openInNewTab({ kind: "task", id })}
        onDelete={async (id) => {
          await tasksStore.remove(id);
          nav.openProjectItem(container.id, "lists", itemId);
        }}
      />
    );
  }
  if (section === "lists" && itemId) {
    return <ListHome projectId={container.id} listId={itemId} />;
  }
  if (section === "canvases" && itemId) {
    return <CanvasPane key={itemId} canvasId={itemId} onDeleted={() => nav.openContainer(container, "canvases")} />;
  }

  // The project's calendar: the events of the calendars it holds, and its own tasks and notes.
  if (section === "calendars") {
    return <CalendarScreen key={container.id} projectId={container.id} />;
  }
  if (section === "habits") {
    return (
      <Center>
        <Text variant="caption" tone="tertiary">
          {SECTION_LABEL[section]} land in a later milestone.
        </Text>
      </Center>
    );
  }
  return <EmptyDetail kind={section === "notes" ? "note" : section === "canvases" ? "canvas" : "task"} />;
}

const styles = {
  ...listStyles,
  root: { flex: 1, minHeight: 0, backgroundColor: colors.surfaceCard },
  header: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    height: layout.titlebarH,
    paddingLeft: space.ml,
    paddingRight: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    flexShrink: 0,
  },
  chipRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.xxs,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    flexShrink: 0,
  },
  chip: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 5,
    height: control.sm,
    paddingHorizontal: 7,
    borderRadius: radius.sm,
  },
  // An emoji sits in the icon's slot; pin the line box so the header never grows around one.
  headerEmoji: { fontSize: 14, lineHeight: 18, flexShrink: 0 },
  detail: { flex: 1, minWidth: 0, minHeight: 0, backgroundColor: colors.surfaceCard },
};
