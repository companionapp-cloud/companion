import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import type { Note, ProjectMember } from "@companion/core-bridge";
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
import { NoteEditor } from "./NoteEditor";
import { ConfirmDialog } from "./ConfirmDialog";

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
    <SplitView storageKey="companion.project.listWidth" defaultWidth={layout.listW} minWidth={240} maxWidth={460} aside={<ListColumn notes={notes} noteCount={noteMembers.length} />}>
      <DetailPane notes={notes} />
    </SplitView>
  );
}

/** The list column: a two-level push sub-nav. Level 0 shows the section menu; pressing
 * a section pushes to that section's item list (with a back to the menu). */
function ListColumn({ notes, noteCount }: { notes: Note[]; noteCount: number }) {
  const nav = useNav();
  const notesStore = useNotes();
  const { addMember } = useProjects();
  const loc = nav.current;
  if (loc.kind !== "project") return null;
  const { projectId, section, itemId } = loc;

  const createInProject = async () => {
    const note = await notesStore.create();
    await addMember(projectId, "note", note.id);
    nav.openProjectItem(projectId, "notes", note.id);
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
            <IconButton label="New note" size="sm" onPress={createInProject}>
              <Icon name="plus" size={16} color={colors.textSecondary} />
            </IconButton>
          ) : null}
        </View>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: space.md, gap: 2 }}>
          {section === "notes" ? (
            notes.length ? (
              notes.map((n) => (
                <ListRow
                  key={n.id}
                  icon={<Icon name="file" size={17} color={n.id === itemId ? colors.accentHover : colors.textTertiary} />}
                  title={n.title || "Untitled"}
                  subtitle={preview(n.contentMd)}
                  selected={n.id === itemId}
                  onPress={() => nav.openProjectItem(projectId, "notes", n.id)}
                />
              ))
            ) : (
              <Text tone="tertiary" variant="caption" style={styles.empty}>
                No notes yet. Add one with ＋, or add existing notes from a note’s “Projects” menu.
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
            trailing={s.id === "notes" ? String(noteCount) : undefined}
            hasChildren
            onPress={() => nav.openProjectSection(projectId, s.id)}
          />
        ))}
      </ScrollView>
    </View>
  );
}

/** The detail pane: the project's home (settings) at the root, a selected note, or a
 * prompt to pick one. */
function DetailPane({ notes }: { notes: Note[] }) {
  const nav = useNav();
  const notesStore = useNotes();
  const loc = nav.current;
  if (loc.kind !== "project") return null;
  const { section, itemId } = loc;

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

  if (section) {
    return (
      <Center>
        <Text tone="tertiary">{section === "notes" ? "Select a note, or start a new one." : `${SECTION_LABEL[section]} land in a later milestone.`}</Text>
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
