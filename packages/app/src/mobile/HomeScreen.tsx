import { useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import type { SidebarArea, SidebarProject } from "@companion/core-bridge";
import { Badge, Icon, IconButton, Input, ProgressRing, Text, colors, font, icon, space, type IconName } from "@companion/design-system";
import { useNav, type ViewId } from "../nav-context";
import { useCore } from "../CoreContext";
import { useNotes } from "../NotesProvider";
import { useTasks } from "../TasksProvider";
import { useProjects } from "../ProjectsProvider";
import { useNotifications } from "../NotificationsProvider";
import { useToolVisibility, type ToolId } from "../ToolVisibilityProvider";
import { CaptureForm } from "../CaptureForm";
import { ConfirmDialog } from "../ConfirmDialog";
import { BottomSheet, Card, CardRow, CountPill, FAB_CLEARANCE, Fab, IconTile, NAV_ICON, SectionLabel } from "./ui";

// The mobile web root — a port of the native app's HomeScreen (apps/mobile). Home owns its
// title, so there is no nav bar: a large "What's new today?" across from the notifications
// bell, a mono date line, one grouped card of the tool sections, then the areas → projects
// tree as a label + grouped card per area. A quick-add FAB opens the capture sheet.
// (Reorder/edit mode stays native-only for now; section order still follows Settings › Tools.)

type SectionView = Extract<ViewId, "today" | "chat" | "notes" | "tasks" | "canvases" | "habits" | "calendar" | "graph" | "logbook" | "trash">;
const SECTIONS: { view: SectionView; label: string; subtitle: string; icon: IconName; accent?: boolean }[] = [
  { view: "today", label: "Today", subtitle: "Today's note and your month", icon: "today" },
  { view: "chat", label: "Chat", subtitle: "Ask, capture, recall — anything", icon: "chat", accent: true },
  { view: "notes", label: "Notes", subtitle: "Your graph of linked ideas", icon: "notes" },
  { view: "tasks", label: "Tasks", subtitle: "What needs doing", icon: "tasks" },
  { view: "canvases", label: "Canvases", subtitle: "Boards for arranging ideas", icon: "canvas" },
  { view: "habits", label: "Habits", subtitle: "Streaks and daily builders", icon: "habits" },
  { view: "calendar", label: "Calendar", subtitle: "Events, tasks, and notes", icon: "calendar" },
  { view: "graph", label: "Graph", subtitle: "See how everything connects", icon: "graph" },
  { view: "logbook", label: "Logbook", subtitle: "Completed tasks and projects", icon: "logbook" },
  { view: "trash", label: "Trash", subtitle: "Recently deleted, kept 30 days", icon: "trash" },
];

/** What a project row reports beneath its name and in its trailing ring. */
interface ProjectCounts {
  notes: number;
  tasks: number;
  done: number;
}

/** Member counts for every project on Home, from the membership index (one read per
 * project, refreshed as memberships change). Done/total comes from the live tasks store,
 * so checking a task off elsewhere moves the ring without a reload. */
function useProjectCounts(projectIds: string[]): Map<string, ProjectCounts> {
  const { core } = useCore();
  const { membershipsForProject } = useProjects();
  const tasks = useTasks();
  const [members, setMembers] = useState<Map<string, { notes: number; taskIds: string[] }>>(new Map());
  const key = projectIds.join(",");
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const ids = key ? key.split(",") : [];
      const rows = await Promise.all(ids.map((id) => membershipsForProject(id).catch(() => [])));
      if (cancelled) return;
      setMembers(
        new Map(
          ids.map((id, i) => [
            id,
            {
              notes: rows[i].filter((m) => m.entityType === "note").length,
              taskIds: rows[i].filter((m) => m.entityType === "task").map((m) => m.entityId),
            },
          ]),
        ),
      );
    };
    void load();
    const offNav = core.on("nav.changed", () => void load());
    const offData = core.on("data.changed", () => void load());
    return () => {
      cancelled = true;
      offNav();
      offData();
    };
  }, [key, membershipsForProject, core]);

  return useMemo(() => {
    const out = new Map<string, ProjectCounts>();
    for (const [id, m] of members) {
      // Count only members the store still knows (a trashed task drops out of both).
      const live = m.taskIds.map((tid) => tasks.byId(tid)).filter((t) => t != null);
      out.set(id, { notes: m.notes, tasks: live.length, done: live.filter((t) => t.status === "done").length });
    }
    return out;
    // `tasks.tasks` identity changes on any task edit; `byId` reads from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, tasks.tasks]);
}

export function HomeScreen() {
  const nav = useNav();
  const store = useNotes();
  const tasks = useTasks();
  const { sidebar, createArea, createProject, deleteArea } = useProjects();
  // Someday projects are filed away (PLAN-scheduling.md §1): off this list, shown on their area's
  // overview. `empty` still counts them — an area holding one can't be deleted.
  const areas = useMemo(
    () => sidebar.areas.map((a) => ({ ...a, empty: a.projects.length === 0, projects: a.projects.filter((p) => !p.someday) })),
    [sidebar.areas],
  );

  const [addingArea, setAddingArea] = useState(false);
  const [areaName, setAreaName] = useState("");
  const [addingProjectFor, setAddingProjectFor] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [capture, setCapture] = useState(false);
  // The empty area pending deletion (its confirm dialog renders over the screen).
  const [deletingArea, setDeletingArea] = useState<SidebarArea | null>(null);

  const submitArea = async () => {
    const name = areaName.trim();
    setAreaName("");
    setAddingArea(false);
    if (name) await createArea({ name });
  };
  const submitProject = async (areaId: string) => {
    const name = projectName.trim();
    setProjectName("");
    setAddingProjectFor(null);
    if (name) await createProject({ areaId, name });
  };

  // Per-device tool hiding + ordering (Settings › Tools): the home sections card is
  // mobile's sidebar-equivalent, so hidden tools drop out and rows follow the saved order.
  const { tools, hidden } = useToolVisibility();
  const orderIndex = new Map(tools.map((t, i) => [t.id, i]));
  const sections = SECTIONS.filter((s) => !hidden.has(s.view as ToolId)).sort(
    (a, b) => (orderIndex.get(a.view as ToolId) ?? 0) - (orderIndex.get(b.view as ToolId) ?? 0),
  );

  const projectIds = useMemo(
    () => [...sidebar.areas.flatMap((a) => a.projects), ...sidebar.unsorted].map((p) => p.id),
    [sidebar.areas, sidebar.unsorted],
  );
  const counts = useProjectCounts(projectIds);
  const openTasks = tasks.tasks.reduce((n, t) => (t.status === "done" ? n : n + 1), 0);

  return (
    <View style={styles.root}>
      {/* Large title — no bar, no branding, no divider. */}
      <View style={styles.header}>
        <Text numberOfLines={1} style={styles.greeting}>
          What's new today?
        </Text>
        <BellButton onPress={() => nav.goView("notifications")} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Text variant="mono" tone="tertiary" style={styles.date}>
          {dateLabel()}
        </Text>

        <Card>
          {sections.map((s, index) => (
            <CardRow
              key={s.view}
              leading={
                <IconTile variant={s.accent ? "accent" : "neutral"}>
                  <Icon name={s.icon} size={icon.tile} color={s.accent ? colors.accent : colors.textSecondary} />
                </IconTile>
              }
              title={s.label}
              subtitle={s.subtitle}
              trailing={
                s.view === "notes" ? (
                  <CountPill>{store.notes.length}</CountPill>
                ) : s.view === "tasks" && !tasks.loading ? (
                  <CountPill>{openTasks}</CountPill>
                ) : undefined
              }
              isLast={index === sections.length - 1}
              onPress={() => nav.goView(s.view)}
            />
          ))}
        </Card>

        {areas.map((area) => (
          <View key={area.id}>
            <SectionLabel
              onPress={() => nav.openArea(area.id)}
              trailing={
                <>
                  {/* Areas are only deletable once empty (PLAN §6.6). */}
                  {area.empty ? (
                    <IconButton label={`Delete area ${area.name}`} onPress={() => setDeletingArea(area)}>
                      <Icon name="trash" size={15} color={colors.textTertiary} />
                    </IconButton>
                  ) : null}
                  <IconButton
                    label={`New project in ${area.name}`}
                    active={addingProjectFor === area.id}
                    onPress={() => {
                      setAddingProjectFor((cur) => (cur === area.id ? null : area.id));
                      setProjectName("");
                    }}
                  >
                    <Icon name="plus" size={16} color={addingProjectFor === area.id ? colors.textAccent : colors.textTertiary} />
                  </IconButton>
                </>
              }
            >
              {area.icon ? `${area.icon} ${area.name}` : area.name}
            </SectionLabel>
            {area.projects.length > 0 || addingProjectFor === area.id ? (
              <Card>
                {area.projects.map((p, i) => (
                  <ProjectRow
                    key={p.id}
                    project={p}
                    counts={counts.get(p.id)}
                    isLast={i === area.projects.length - 1 && addingProjectFor !== area.id}
                    onPress={() => nav.openProject(p.id)}
                  />
                ))}
                {addingProjectFor === area.id ? (
                  <CreateInput placeholder="Name the project, press Enter" value={projectName} onChangeText={setProjectName} onSubmit={() => void submitProject(area.id)} />
                ) : null}
              </Card>
            ) : (
              <Text tone="tertiary" variant="caption" style={styles.areaEmpty}>
                No projects yet.
              </Text>
            )}
          </View>
        ))}

        {sidebar.unsorted.length > 0 ? (
          <View>
            <SectionLabel>Unsorted</SectionLabel>
            <Card>
              {sidebar.unsorted.map((p, i) => (
                <ProjectRow key={p.id} project={p} counts={counts.get(p.id)} isLast={i === sidebar.unsorted.length - 1} onPress={() => nav.openProject(p.id)} />
              ))}
            </Card>
          </View>
        ) : null}

        {sidebar.areas.length === 0 && sidebar.unsorted.length === 0 && !addingArea ? (
          <Text tone="tertiary" variant="caption" style={styles.empty}>
            No areas yet. Group your work into areas and projects — add one below.
          </Text>
        ) : null}

        <SectionLabel>More</SectionLabel>
        <Card>
          {addingArea ? (
            <CreateInput placeholder="Name the area, press Enter" value={areaName} onChangeText={setAreaName} onSubmit={() => void submitArea()} divided />
          ) : (
            <CardRow
              leading={
                <IconTile variant="neutral">
                  <Icon name="plus" size={icon.tile} color={colors.textSecondary} />
                </IconTile>
              }
              title="New area"
              subtitle="A heading for related projects"
              showChevron={false}
              onPress={() => setAddingArea(true)}
            />
          )}
          <CardRow
            leading={
              <IconTile variant="neutral">
                <Icon name="settings" size={icon.tile} color={colors.textSecondary} />
              </IconTile>
            }
            title="Settings"
            subtitle="Account, sync, appearance"
            isLast
            onPress={() => nav.goView("settings")}
          />
        </Card>
        <View style={{ height: FAB_CLEARANCE }} />
      </ScrollView>

      <Fab label="Quick capture" onPress={() => setCapture(true)} />

      {/* Quick capture is a bottom sheet here: the shared CaptureForm (note or task),
          mounted fresh each time it opens. Create-and-close. */}
      {capture ? (
        <BottomSheet onClose={() => setCapture(false)}>
          <CaptureForm onClose={() => setCapture(false)} />
        </BottomSheet>
      ) : null}

      {deletingArea ? (
        <ConfirmDialog
          title="Delete area?"
          message={`Delete the area “${deletingArea.name}”? It has no projects, so nothing else is affected.`}
          confirmLabel="Delete area"
          onConfirm={async () => {
            await deleteArea(deletingArea.id);
            setDeletingArea(null);
          }}
          onClose={() => setDeletingArea(null)}
        />
      ) : null}
    </View>
  );
}

function ProjectRow({ project, counts, isLast, onPress }: { project: SidebarProject; counts?: ProjectCounts; isLast?: boolean; onPress: () => void }) {
  const noun = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  return (
    <CardRow
      leading={
        <IconTile variant="neutral">
          <Icon name="folder" size={19} color={project.color ?? colors.textSecondary} />
        </IconTile>
      }
      title={project.name}
      subtitle={counts ? `${noun(counts.notes, "note")} · ${noun(counts.tasks, "task")}` : undefined}
      trailing={
        project.taskProgress != null ? (
          <View style={styles.progress}>
            <ProgressRing value={project.taskProgress} size={16} />
            {counts && counts.tasks > 0 ? (
              <Text variant="mono" tone="quaternary">
                {counts.done}/{counts.tasks}
              </Text>
            ) : null}
          </View>
        ) : undefined
      }
      isLast={isLast}
      onPress={onPress}
    />
  );
}

/** An inline name field, sat in a card where the new row will land. Commits on Enter or
 * blur; an empty name cancels. */
function CreateInput({
  placeholder,
  value,
  onChangeText,
  onSubmit,
  divided,
}: {
  placeholder: string;
  value: string;
  onChangeText: (t: string) => void;
  onSubmit: () => void;
  divided?: boolean;
}) {
  // Enter unmounts the field, which can blur it on the way out — commit once per mount.
  const committed = useRef(false);
  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    onSubmit();
  };
  return (
    <View style={[styles.createInput, divided ? styles.createInputDivided : null]}>
      <Input autoFocus placeholder={placeholder} value={value} onChangeText={onChangeText} onSubmitEditing={commit} onBlur={commit} />
    </View>
  );
}

/** `Thursday 17 September` — the mono line under the title. */
function dateLabel(): string {
  const d = new Date();
  const weekday = d.toLocaleDateString(undefined, { weekday: "long" });
  const month = d.toLocaleDateString(undefined, { month: "long" });
  return `${weekday} ${d.getDate()} ${month}`;
}

/** Header bell: opens the notifications feed, with a round unread count beside it
 * (PLAN §6.4). */
function BellButton({ onPress }: { onPress: () => void }) {
  const { unreadCount } = useNotifications();
  return (
    <View style={styles.bell}>
      <IconButton label="Notifications" size="lg" onPress={onPress}>
        <Icon name="bell" size={NAV_ICON} color={colors.textSecondary} />
      </IconButton>
      {unreadCount > 0 ? <Badge label={unreadCount > 9 ? "9+" : String(unreadCount)} tone="danger" round /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceApp },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingLeft: space.xl,
    paddingRight: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.xs,
  },
  greeting: {
    flex: 1,
    minWidth: 0,
    fontFamily: font.sans,
    fontSize: 22,
    lineHeight: 28,
    fontWeight: font.weight.semibold,
    letterSpacing: -0.55, // font.tracking.tight's -0.025em, at 22px
    color: colors.textPrimary,
  },
  bell: { flexDirection: "row", alignItems: "center", gap: space.xxs },
  date: { paddingHorizontal: space.sm, paddingBottom: space.ml },
  scroll: { paddingHorizontal: space.ml, paddingBottom: space.xl },
  areaEmpty: { paddingHorizontal: space.sm, paddingBottom: space.xs },
  progress: { flexDirection: "row", alignItems: "center", gap: space.sm },
  createInput: { paddingHorizontal: space.xl, paddingVertical: space.lg },
  createInputDivided: { borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  empty: { paddingHorizontal: space.sm, paddingTop: space.lg, lineHeight: 18 },
});
