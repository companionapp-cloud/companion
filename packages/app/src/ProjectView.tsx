import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
import type { Canvas, Note, ProjectMember, RepeatingTask, Task } from "@companion/core-bridge";
import {
  Button,
  Center,
  Icon,
  IconButton,
  Input,
  ListRow,
  ProgressRing,
  SplitView,
  Text,
  TextField,
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
import { useNav, type ProjectSection } from "./nav-context";
import { useToolVisibility, type ToolId } from "./ToolVisibilityProvider";
import { useCore } from "./CoreContext";
import { useProjects } from "./ProjectsProvider";
import { useNotes } from "./NotesProvider";
import { useTasks, filterTasksByDue } from "./TasksProvider";
import { ListFilterMenu } from "./ListFilterMenu";
import { NoteEditor } from "./NoteEditor";
import { TaskEditor, TaskRow } from "./TaskEditor";
import { DeleteProjectDialog } from "./DeleteProjectDialog";
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

/** The project content-details view (PLAN §6.6), rendered in the main content area (not a
 * modal): a 32px header (name, task progress, settings), a row of section chips, then a
 * split of that section's dense list beside the selected item's editor. Nothing is selected
 * on the user's behalf — a section opens on the empty state, and switching section drops
 * the selection. Every level is a deep-linkable URL: /project/<id>[/<section>[/<itemId>]];
 * the bare project URL shows its first section. */
export function ProjectView() {
  const nav = useNav();
  const { core } = useCore();
  const { projects, membershipsForProject } = useProjects();
  const notesStore = useNotes();
  const tasksStore = useTasks();
  // Hiding a tool in Settings › Tools also drops its project section from the chips.
  const { hidden } = useToolVisibility();
  const loc = nav.current;
  // The project's settings page (name, area, delete) takes over the body while open.
  const [showSettings, setShowSettings] = useState(false);

  // A project's live memberships, kept fresh as they change locally or via sync.
  const projectId = loc.kind === "project" ? loc.projectId : "";
  const [members, setMembers] = useState<ProjectMember[]>([]);
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    const load = () => membershipsForProject(projectId).then((rows) => !cancelled && setMembers(rows));
    void load();
    const offNav = core.on("nav.changed", () => void load());
    const offData = core.on("data.changed", () => void load());
    return () => {
      cancelled = true;
      offNav();
      offData();
    };
  }, [projectId, membershipsForProject, core]);

  const noteMembers = useMemo(() => members.filter((m) => m.entityType === "note"), [members]);
  const notes = useMemo(
    () => noteMembers.map((m) => notesStore.byId(m.entityId)).filter((n): n is Note => !!n),
    [noteMembers, notesStore],
  );
  const taskMembers = useMemo(() => members.filter((m) => m.entityType === "task"), [members]);
  // Actionable member tasks. Repeating-task seeds are members too but live in `seeds`
  // (excluded from the actionable list), so they're resolved separately below and shown in
  // their own "Repeating" section — matching the root task list (§6.4).
  const tasks = useMemo(
    () => taskMembers.map((m) => tasksStore.byId(m.entityId)).filter((t): t is Task => !!t),
    [taskMembers, tasksStore],
  );
  const seeds = useMemo(
    () => taskMembers.map((m) => tasksStore.seedById(m.entityId)).filter((s): s is RepeatingTask => !!s),
    [taskMembers, tasksStore],
  );
  const canvasesStore = useCanvases();
  const canvasMembers = useMemo(() => members.filter((m) => m.entityType === "canvas"), [members]);
  const canvases = useMemo(
    () => canvasMembers.map((m) => canvasesStore.byId(m.entityId)).filter((c): c is Canvas => !!c),
    [canvasMembers, canvasesStore],
  );

  const projectLists = useProjectLists(projectId);
  // Calendars filed in the project: single calendars and whole accounts.
  const calendarCount = useMemo(
    () => members.filter((m) => m.entityType === "calendar" || m.entityType === "calendar_account").length,
    [members],
  );

  // Navigating anywhere inside the project (a chip, a row, another project) leaves settings.
  const locSection = loc.kind === "project" ? loc.section : undefined;
  const locItem = loc.kind === "project" ? loc.itemId : undefined;
  useEffect(() => setShowSettings(false), [projectId, locSection, locItem]);

  if (loc.kind !== "project") return null;
  const project = projects.find((p) => p.id === loc.projectId);
  if (!project) {
    return (
      <Center>
        <Text tone="tertiary">This project is gone.</Text>
      </Center>
    );
  }

  const sections = SECTIONS.filter((s) => !hidden.has(s.tool));
  // The bare project URL lands on the first section's list (with nothing selected).
  const section: ProjectSection | undefined = loc.section ?? sections[0]?.id;
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
        <Icon name="folder" size={icon.md} color={project.color ?? colors.textSecondary} />
        <Text variant="title" numberOfLines={1} style={{ flexShrink: 1 }}>
          {project.name}
        </Text>
        {tasks.length ? (
          <>
            <ProgressRing value={doneCount / tasks.length} />
            <Text variant="mono" tone="quaternary">
              {doneCount}/{tasks.length} done
            </Text>
          </>
        ) : null}
        <View style={{ flex: 1 }} />
        <IconButton label="Project settings" size="sm" active={showSettings || !section} onPress={() => setShowSettings((v) => !v)}>
          <Icon name="settings" size={13} color={showSettings ? colors.textAccent : colors.textSecondary} />
        </IconButton>
      </View>

      {sections.length ? (
        <View style={styles.chipRow}>
          {sections.map((s) => (
            <SectionChip
              key={s.id}
              label={s.label}
              count={counts[s.id]}
              selected={!showSettings && s.id === section}
              onPress={() => {
                setShowSettings(false);
                // Re-picking the open section keeps its selection; a different one clears it.
                if (s.id !== section || !loc.section) nav.openProjectSection(project.id, s.id);
              }}
            />
          ))}
        </View>
      ) : null}

      {showSettings || !section ? (
        <ProjectHome notes={notes} />
      ) : (
        <SplitView
          storageKey="companion.project.listWidth"
          defaultWidth={layout.listW}
          minWidth={200}
          maxWidth={440}
          aside={<ListColumn section={section} notes={notes} tasks={tasks} seeds={seeds} canvases={canvases} />}
        >
          <DetailPane section={section} />
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
function ListColumn({ section, notes, tasks, seeds, canvases }: { section: ProjectSection; notes: Note[]; tasks: Task[]; seeds: RepeatingTask[]; canvases: Canvas[] }) {
  const nav = useNav();
  const notesStore = useNotes();
  const tasksStore = useTasks();
  const canvasesStore = useCanvases();
  const { addMember } = useProjects();
  const ms = useMultiSelect();
  const loc = nav.current;

  // Per-section list controls: a search box narrows the notes list, a due-date filter
  // narrows the tasks list (all / upcoming / overdue). Local to this column.
  const [noteQuery, setNoteQuery] = useState("");
  const [taskFilter, setTaskFilter] = useState<"all" | "upcoming" | "overdue">("all");
  // The project's lists, so the tasks header dropdown can jump straight into one.
  const projectLists = useProjectLists(loc.kind === "project" ? loc.projectId : "");
  const [taskDraft, setTaskDraft] = useState("");
  const filteredNotes = useMemo(() => {
    const q = noteQuery.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter((n) => n.title.toLowerCase().includes(q) || n.contentMd.toLowerCase().includes(q));
  }, [notes, noteQuery]);
  const filteredTasks = useMemo(
    () => (taskFilter === "all" ? tasks : filterTasksByDue(tasks, taskFilter)),
    [tasks, taskFilter],
  );
  // Completed tasks drop to their own section at the bottom, as in the root task list (§6.4).
  const openTasks = useMemo(() => filteredTasks.filter((t) => t.status !== "done"), [filteredTasks]);
  const doneTasks = useMemo(() => filteredTasks.filter((t) => t.status === "done"), [filteredTasks]);

  // Register the on-screen section list for multiselect (notes / actionable tasks; seeds
  // stay single-select). Scoped per project+section so switching lists drops the selection.
  // Registers the filtered order so range-select matches what's shown. Only while this tab
  // is the one on screen — background tabs stay mounted and would fight for the scope.
  const secProjectId = loc.kind === "project" ? loc.projectId : "";
  const secSection = section;
  useEffect(() => {
    if (!nav.visible) return;
    if (secSection === "notes") ms.register(`project:${secProjectId}:notes`, "note", filteredNotes.map((n) => n.id));
    else if (secSection === "tasks") ms.register(`project:${secProjectId}:tasks`, "task", [...openTasks, ...doneTasks].map((t) => t.id));
  }, [ms.register, secProjectId, secSection, filteredNotes, openTasks, doneTasks, nav.visible]);

  if (loc.kind !== "project") return null;
  const { projectId, itemId, subItemId } = loc;

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
        onSelect={(id) => nav.openProjectItem(projectId, "canvases", id)}
        onCreate={() => {
          void (async () => {
            const c = await canvasesStore.create();
            await addMember(projectId, "canvas", c.id);
            nav.openProjectItem(projectId, "canvases", c.id);
          })();
        }}
      />
    );
  }

  const createNoteInProject = async () => {
    const note = await notesStore.create();
    await addMember(projectId, "note", note.id);
    nav.openProjectItem(projectId, "notes", note.id);
  };
  const createTaskInProject = async (title?: string) => {
    const task = await tasksStore.create({ title: title?.trim() || "Untitled task" });
    await addMember(projectId, "task", task.id);
    nav.openProjectItem(projectId, "tasks", task.id);
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
            <ListFilterMenu<"all" | "upcoming" | "overdue" | `list:${string}`>
              value={taskFilter}
              onChange={(v) => {
                // List entries jump into that list's ordered view; the rest filter in place.
                if (v.startsWith("list:")) nav.openProjectItem(projectId, "lists", v.slice(5));
                else setTaskFilter(v as "all" | "upcoming" | "overdue");
              }}
              options={[
                { value: "all", label: "All tasks" },
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
                  trailing={timeAgo(n.updatedAt)}
                  selected={selected}
                  onPress={(e) => {
                    if (!ms.press(n.id, pressMods(e))) nav.openProjectItem(projectId, "notes", n.id);
                  }}
                />
              );
            })
          ) : (
            <Text tone="tertiary" variant="caption" style={styles.empty}>
              {noteQuery
                ? "No notes match that."
                : "No notes yet. Add one with ＋, or add existing notes from a note’s “Projects” menu."}
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
                    if (!ms.press(t.id, pressMods(e))) nav.openProjectItem(projectId, "tasks", t.id);
                  }}
                  onToggle={() => void tasksStore.setStatus(t.id, "done")}
                />
              ))}
              {/* Repeating definitions have no concrete due date, so hide them under a due filter. */}
              {taskFilter === "all" && seeds.length ? (
                <>
                  <Text variant="eyebrow" tone="quaternary" style={styles.sectionLabel}>
                    Repeating · {seeds.length}
                  </Text>
                  {seeds.map((s) => (
                    <ListRow
                      key={s.id}
                      icon={<Icon name="repeat" size={icon.sm} color={s.id === itemId ? colors.textAccent : colors.textQuaternary} />}
                      title={s.title || "Untitled task"}
                      subtitle={repeatSubtitle(s.repeatRule, s.nextOccurrence)}
                      selected={s.id === itemId}
                      onPress={() => nav.openProjectItem(projectId, "tasks", s.id)}
                    />
                  ))}
                </>
              ) : null}
              {doneTasks.length ? (
                <>
                  <Text variant="eyebrow" tone="quaternary" style={styles.sectionLabel}>
                    Completed · {doneTasks.length}
                  </Text>
                  {doneTasks.map((t) => (
                    <TaskRow
                      key={t.id}
                      task={t}
                      selected={ms.active ? ms.isSelected(t.id) : t.id === itemId}
                      onPress={(e) => {
                        if (!ms.press(t.id, pressMods(e))) nav.openProjectItem(projectId, "tasks", t.id);
                      }}
                      onToggle={() => void tasksStore.setStatus(t.id, "open")}
                    />
                  ))}
                </>
              ) : null}
            </>
          ) : (
            <Text tone="tertiary" variant="caption" style={styles.empty}>
              {taskFilter === "upcoming"
                ? "No upcoming tasks in this project."
                : taskFilter === "overdue"
                  ? "No overdue tasks in this project."
                  : "No tasks yet. Add one with ＋, or add existing tasks from a task’s “Projects” menu."}
            </Text>
          )
        ) : (
          <Text tone="tertiary" variant="caption" style={styles.empty}>
            {SECTION_LABEL[section]} for this project arrive in a later milestone.
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

/** The detail pane: the selected note, task, list or canvas — or the empty state. Nothing
 * is picked on the user's behalf. */
function DetailPane({ section }: { section: ProjectSection }) {
  const nav = useNav();
  const notesStore = useNotes();
  const tasksStore = useTasks();
  const ms = useMultiSelect();
  const loc = nav.current;
  if (loc.kind !== "project") return null;
  const { itemId, subItemId } = loc;

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
          nav.openProjectSection(loc.projectId, "notes");
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
          nav.openProjectSection(loc.projectId, "tasks");
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
          nav.openProjectItem(loc.projectId, "lists", itemId);
        }}
      />
    );
  }
  if (section === "lists" && itemId) {
    return <ListHome projectId={loc.projectId} listId={itemId} />;
  }
  if (section === "canvases" && itemId) {
    return <CanvasPane key={itemId} canvasId={itemId} onDeleted={() => nav.openProjectSection(loc.projectId, "canvases")} />;
  }

  // The project's calendar: the events of the calendars it holds, and its own tasks and notes.
  if (section === "calendars") {
    return <CalendarScreen key={loc.projectId} projectId={loc.projectId} />;
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

/** The project's settings page (behind the header's settings button): editable name, area
 * reassignment, a peek at recent notes, and delete. */
function ProjectHome({ notes }: { notes: Note[] }) {
  const nav = useNav();
  const { projects, areas, updateProject, deleteProject } = useProjects();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const loc = nav.current;
  const project = loc.kind === "project" ? projects.find((p) => p.id === loc.projectId) : undefined;
  if (!project || loc.kind !== "project") return null;

  return (
    <View style={styles.detail}>
    <ScrollView contentContainerStyle={styles.home}>
      <View style={styles.titleRow}>
        <View style={[styles.dot, { backgroundColor: project.color ?? colors.borderStrong }]} />
        <TextField variant="title" value={project.name} placeholder="Project name" onChangeText={(t) => t.trim() && void updateProject(project.id, { name: t.trim() })} />
      </View>

      <Text variant="eyebrow" tone="quaternary" style={styles.groupLabel}>
        Area
      </Text>
      <View style={styles.chips}>
        {areas.map((a) => {
          const on = a.id === project.areaId;
          return (
            <Pressable
              key={a.id}
              onPress={() => void updateProject(project.id, { areaId: a.id })}
              aria-label={a.name}
              style={({ hovered, pressed }: PressState) => [
                styles.chip,
                styles.areaChip,
                on ? styles.areaChipOn : { backgroundColor: pressed ? colors.surfaceActive : hovered ? colors.surfaceHover : "transparent" },
              ]}
            >
              <Text variant="caption" tone={on ? "accent" : "secondary"}>
                {a.name}
              </Text>
            </Pressable>
          );
        })}
        {areas.length === 0 ? (
          <Text variant="caption" tone="tertiary">
            No areas yet.
          </Text>
        ) : null}
      </View>

      <Text variant="eyebrow" tone="quaternary" style={styles.groupLabel}>
        Recent notes
      </Text>
      {notes.length ? (
        <View style={styles.card}>
          {notes.slice(0, 5).map((n) => (
            <ListRow
              key={n.id}
              icon={<Icon name={n.date ? "today" : "file"} size={icon.sm} color={colors.textQuaternary} />}
              title={n.title || "Untitled"}
              trailing={timeAgo(n.updatedAt)}
              onPress={() => nav.openProjectItem(project.id, "notes", n.id)}
            />
          ))}
        </View>
      ) : (
        <Text tone="tertiary" variant="caption">
          No notes yet. Open the Notes section to add one.
        </Text>
      )}

      <View style={styles.footer}>
        <Button label="Delete project" variant="danger" size="sm" onPress={() => setConfirmDelete(true)} />
      </View>
    </ScrollView>

    {confirmDelete ? (
      <DeleteProjectDialog
        projectName={project.name}
        onConfirm={async (deleteContent) => {
          await deleteProject(project.id, deleteContent);
          nav.back();
        }}
        onClose={() => setConfirmDelete(false)}
      />
    ) : null}
    </View>
  );
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
  detail: { flex: 1, minWidth: 0, minHeight: 0, backgroundColor: colors.surfaceCard },
  dot: { width: 8, height: 8, borderRadius: radius.full, flexShrink: 0 },
  groupLabel: { marginTop: space.md },
  chips: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: space.xs },
  // Area choices are bordered chips (a pick-one set), unlike the borderless section chips.
  areaChip: { borderWidth: 1, borderColor: colors.borderSubtle, paddingHorizontal: 6 },
  areaChipOn: { borderColor: colors.accentSoftBorder, backgroundColor: colors.accentSoft },
  card: { borderRadius: radius.lg, borderWidth: 1, borderColor: colors.borderSubtle, overflow: "hidden" as const, padding: space.xs, gap: 1 },
};
