import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
import type { Note, ProjectMember, RepeatingTask, Task } from "@companion/core-bridge";
import {
  Button,
  Center,
  Icon,
  IconButton,
  ListRow,
  SplitView,
  Text,
  TextField,
  colors,
  layout,
  radius,
  space,
  type IconName,
} from "@companion/design-system";
import { useNav, type ProjectSection } from "./nav-context";
import { useCore } from "./CoreContext";
import { useProjects } from "./ProjectsProvider";
import { useNotes } from "./NotesProvider";
import { useTasks } from "./TasksProvider";
import { NoteEditor } from "./NoteEditor";
import { TaskEditor, TaskRow } from "./TaskEditor";
import { ConfirmDialog } from "./ConfirmDialog";
import { repeatSubtitle } from "./repeat";
import { useMultiSelect, pressMods } from "./MultiSelectProvider";
import { SelectionStack } from "./SelectionStack";
import { MultiSelectBar } from "./MultiSelectBar";

const SECTIONS: { id: ProjectSection; label: string; icon: IconName }[] = [
  { id: "notes", label: "Notes", icon: "notes" },
  { id: "tasks", label: "Tasks", icon: "tasks" },
  { id: "calendars", label: "Calendars", icon: "calendar" },
  { id: "habits", label: "Habits", icon: "habits" },
];
const SECTION_LABEL: Record<ProjectSection, string> = { notes: "Notes", tasks: "Tasks", calendars: "Calendars", habits: "Habits" };

/** The project content-details view (PLAN §6.6) — a master-detail rendered in the main
 * content area (not a modal). The list column carries a push sub-nav (Notes / Tasks /
 * Calendars / Habits → that section's item list); the detail pane shows the selected
 * item. Every level is a deep-linkable URL: /project/<id>[/<section>[/<itemId>]]. */
export function ProjectView() {
  const nav = useNav();
  const { core } = useCore();
  const { projects, membershipsForProject } = useProjects();
  const notesStore = useNotes();
  const tasksStore = useTasks();
  const loc = nav.current;

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

  if (loc.kind !== "project") return null;
  const project = projects.find((p) => p.id === loc.projectId);
  if (!project) {
    return (
      <Center>
        <Text tone="tertiary">This project is gone.</Text>
      </Center>
    );
  }

  return (
    <SplitView storageKey="companion.project.listWidth" defaultWidth={layout.listW} minWidth={240} maxWidth={460} aside={<ListColumn notes={notes} tasks={tasks} seeds={seeds} noteCount={noteMembers.length} taskCount={taskMembers.length} />}>
      <DetailPane notes={notes} />
    </SplitView>
  );
}

/** The list column: a two-level push sub-nav. Level 0 shows the section menu; pressing
 * a section pushes to that section's item list (with a back to the menu). */
function ListColumn({ notes, tasks, seeds, noteCount, taskCount }: { notes: Note[]; tasks: Task[]; seeds: RepeatingTask[]; noteCount: number; taskCount: number }) {
  const nav = useNav();
  const notesStore = useNotes();
  const tasksStore = useTasks();
  const { addMember } = useProjects();
  const ms = useMultiSelect();
  const loc = nav.current;

  // Register the on-screen section list for multiselect (notes / actionable tasks; seeds
  // stay single-select). Scoped per project+section so switching lists drops the selection.
  const secProjectId = loc.kind === "project" ? loc.projectId : "";
  const secSection = loc.kind === "project" ? loc.section : undefined;
  useEffect(() => {
    if (secSection === "notes") ms.register(`project:${secProjectId}:notes`, "note", notes.map((n) => n.id));
    else if (secSection === "tasks") ms.register(`project:${secProjectId}:tasks`, "task", tasks.map((t) => t.id));
  }, [ms.register, secProjectId, secSection, notes, tasks]);

  if (loc.kind !== "project") return null;
  const { projectId, section, itemId } = loc;

  const createNoteInProject = async () => {
    const note = await notesStore.create();
    await addMember(projectId, "note", note.id);
    nav.openProjectItem(projectId, "notes", note.id);
  };
  const createTaskInProject = async () => {
    const task = await tasksStore.create({ title: "Untitled task" });
    await addMember(projectId, "task", task.id);
    nav.openProjectItem(projectId, "tasks", task.id);
  };

  // Section list (level 1).
  if (section) {
    return (
      <View style={styles.list}>
        <View style={styles.listHeader}>
          <IconButton label="Back to sections" size="sm" onPress={() => nav.openProject(projectId)}>
            <Icon name="chevronLeft" size={18} color={colors.textSecondary} />
          </IconButton>
          <Text variant="caption" tone="secondary" style={{ flex: 1, fontWeight: "600" }}>
            {SECTION_LABEL[section]}
          </Text>
          {section === "notes" ? (
            <IconButton label="New note" size="sm" onPress={createNoteInProject}>
              <Icon name="plus" size={16} color={colors.textSecondary} />
            </IconButton>
          ) : section === "tasks" ? (
            <IconButton label="New task" size="sm" onPress={createTaskInProject}>
              <Icon name="plus" size={16} color={colors.textSecondary} />
            </IconButton>
          ) : null}
        </View>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: space.md, gap: 2 }}>
          {section === "notes" ? (
            notes.length ? (
              notes.map((n) => {
                const selected = ms.active ? ms.isSelected(n.id) : n.id === itemId;
                return (
                  <ListRow
                    key={n.id}
                    icon={<Icon name="file" size={17} color={selected ? colors.accentHover : colors.textTertiary} />}
                    title={n.title || "Untitled"}
                    subtitle={preview(n.contentMd)}
                    selected={selected}
                    onPress={(e) => {
                      if (!ms.press(n.id, pressMods(e))) nav.openProjectItem(projectId, "notes", n.id);
                    }}
                  />
                );
              })
            ) : (
              <Text tone="tertiary" variant="caption" style={styles.empty}>
                No notes yet. Add one with ＋, or add existing notes from a note’s “Projects” menu.
              </Text>
            )
          ) : section === "tasks" ? (
            tasks.length || seeds.length ? (
              <>
                {tasks.map((t) => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    selected={ms.active ? ms.isSelected(t.id) : t.id === itemId}
                    onPress={(e) => {
                      if (!ms.press(t.id, pressMods(e))) nav.openProjectItem(projectId, "tasks", t.id);
                    }}
                    onToggle={() => void tasksStore.setStatus(t.id, t.status === "done" ? "open" : "done")}
                  />
                ))}
                {seeds.length ? (
                  <>
                    <Text variant="caption" tone="tertiary" style={styles.sectionLabel}>
                      REPEATING · {seeds.length}
                    </Text>
                    {seeds.map((s) => (
                      <ListRow
                        key={s.id}
                        icon={<Icon name="repeat" size={16} color={s.id === itemId ? colors.accentHover : colors.textTertiary} />}
                        title={s.title || "Untitled task"}
                        subtitle={repeatSubtitle(s.repeatRule, s.nextOccurrence)}
                        selected={s.id === itemId}
                        onPress={() => nav.openProjectItem(projectId, "tasks", s.id)}
                      />
                    ))}
                  </>
                ) : null}
              </>
            ) : (
              <Text tone="tertiary" variant="caption" style={styles.empty}>
                No tasks yet. Add one with ＋, or add existing tasks from a task’s “Projects” menu.
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

  // Section menu (level 0).
  return (
    <View style={styles.list}>
      <View style={styles.listHeader}>
        <Text variant="caption" tone="secondary" style={{ flex: 1, fontWeight: "600" }}>
          Sections
        </Text>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: space.md, gap: 2 }}>
        {SECTIONS.map((s) => (
          <ListRow
            key={s.id}
            icon={<Icon name={s.icon} size={18} color={colors.textSecondary} />}
            title={s.label}
            trailing={s.id === "notes" ? String(noteCount) : s.id === "tasks" ? String(taskCount) : undefined}
            hasChildren
            onPress={() => nav.openProjectSection(projectId, s.id)}
          />
        ))}
      </ScrollView>
    </View>
  );
}

/** The detail pane: the project's home (settings) at the root, a selected note or task, or
 * a prompt to pick one. */
function DetailPane({ notes }: { notes: Note[] }) {
  const nav = useNav();
  const notesStore = useNotes();
  const tasksStore = useTasks();
  const ms = useMultiSelect();
  const loc = nav.current;
  if (loc.kind !== "project") return null;
  const { section, itemId } = loc;

  // A multiselection takes over the detail pane: the bulk sub-toolbar + the selection stack
  // showing the first selected item, instead of the single-item editor.
  if (ms.active) {
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
      <View style={{ flex: 1, minHeight: 0 }}>
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
        onPopOut={(id) => nav.openNote(id)}
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
        onDelete={async (id) => {
          await tasksStore.remove(id);
          nav.openProjectSection(loc.projectId, "tasks");
        }}
      />
    );
  }

  if (section) {
    const prompt =
      section === "notes"
        ? "Select a note, or start a new one."
        : section === "tasks"
          ? "Select a task, or add a new one."
          : `${SECTION_LABEL[section]} land in a later milestone.`;
    return (
      <Center>
        <Text tone="tertiary">{prompt}</Text>
      </Center>
    );
  }

  // Project home (root): settings + a peek at the content.
  return <ProjectHome notes={notes} />;
}

/** The project root detail: editable name, area reassignment, and delete. */
function ProjectHome({ notes }: { notes: Note[] }) {
  const nav = useNav();
  const { projects, areas, updateProject, deleteProject } = useProjects();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const loc = nav.current;
  const project = loc.kind === "project" ? projects.find((p) => p.id === loc.projectId) : undefined;
  if (!project || loc.kind !== "project") return null;

  return (
    <View style={{ flex: 1 }}>
    <ScrollView contentContainerStyle={styles.home}>
      <View style={styles.titleRow}>
        <View style={[styles.dot, { backgroundColor: project.color ?? colors.borderStrong }]} />
        <TextField variant="title" value={project.name} placeholder="Project name" onChangeText={(t) => t.trim() && void updateProject(project.id, { name: t.trim() })} />
      </View>

      <Text variant="caption" tone="tertiary" style={styles.groupLabel}>
        AREA
      </Text>
      <View style={styles.chips}>
        {areas.map((a) => {
          const on = a.id === project.areaId;
          return (
            <Pressable key={a.id} onPress={() => void updateProject(project.id, { areaId: a.id })} style={[styles.chip, on ? styles.chipOn : null]}>
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

      <Text variant="caption" tone="tertiary" style={styles.groupLabel}>
        RECENT NOTES
      </Text>
      {notes.length ? (
        <View style={styles.card}>
          {notes.slice(0, 5).map((n) => (
            <ListRow
              key={n.id}
              icon={<Icon name="file" size={17} color={colors.textTertiary} />}
              title={n.title || "Untitled"}
              subtitle={preview(n.contentMd)}
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
        <Button label="Delete project" variant="secondary" onPress={() => setConfirmDelete(true)} />
      </View>
    </ScrollView>

    {confirmDelete ? (
      <ConfirmDialog
        title="Delete project?"
        message={`This permanently deletes “${project.name}” and its organization. Notes stay in your library. This can’t be undone.`}
        confirmLabel="Delete project"
        confirmText={project.name}
        confirmTextPrompt="Type the project name to confirm:"
        onConfirm={async () => {
          await deleteProject(project.id);
          nav.back();
        }}
        onClose={() => setConfirmDelete(false)}
      />
    ) : null}
    </View>
  );
}

function preview(md: string): string {
  const body = md.replace(/\s+/g, " ").trim();
  return body || "No additional text";
}

const styles = {
  list: { flex: 1, minHeight: 0, backgroundColor: colors.surfaceCard },
  listHeader: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  empty: { padding: space.xl, lineHeight: 20, textAlign: "center" as const },
  sectionLabel: { fontWeight: "600" as const, letterSpacing: 0.5, paddingHorizontal: space.md, paddingTop: space.lg, paddingBottom: space.xs },
  home: { maxWidth: layout.contentMax, width: "100%" as const, marginHorizontal: "auto" as const, padding: space.xxl, gap: space.lg },
  titleRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.md },
  dot: { width: 12, height: 12, borderRadius: radius.full, flexShrink: 0 },
  groupLabel: { fontWeight: "600" as const, letterSpacing: 0.5, marginTop: space.md },
  chips: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: space.sm },
  chip: { paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.full, borderWidth: 1, borderColor: colors.borderDefault },
  chipOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  card: { backgroundColor: colors.surfaceCard, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.borderSubtle, overflow: "hidden" as const, padding: space.xs },
  footer: { marginTop: space.xl, alignItems: "flex-start" as const },
};
