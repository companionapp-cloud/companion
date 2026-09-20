import { useContext, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View, type GestureResponderEvent } from "react-native";
import type { Project, Task } from "@companion/core-bridge";
import { Button, Center, Icon, Spinner, SplitView, Text, colors, icon, layout, motion, radius, row, space, transition, useDensity, type PressState } from "@companion/design-system";
import { NavContext } from "./nav-context";
import { useProjects } from "./ProjectsProvider";
import { useTasks } from "./TasksProvider";
import { Checkbox, TaskEditor } from "./TaskEditor";
import { DateGroupHeading } from "./TaskGroups";
import { groupByDate } from "./taskSchedule";
import { ContainerHome } from "./ContainerHome";
import { useContainerContent } from "./useContainerContent";
import { pressMods, useOptionalMultiSelect, type MultiSelectStore } from "./MultiSelectProvider";
import { MultiSelectBar } from "./MultiSelectBar";
import { SelectionStack } from "./SelectionStack";

/** One finished thing: a task, or a whole project. */
type Entry = { kind: "task"; id: string; at: Date; task: Task } | { kind: "project"; id: string; at: Date; project: Project };

// How many entries show before "Show older": a years-deep Logbook (an import brings thousands)
// shouldn't mount every row at once.
const PAGE = 200;

/** The Logbook (PLAN-scheduling.md §6): everything finished — completed tasks and completed
 *  projects — by the day it was completed, newest first: Today, Yesterday, the earlier days of
 *  this month, the earlier months of this year, then the years before. Unticking a task, or
 *  reopening a project from its page, takes it back out.
 *
 *  With a pointer it is a split view: the list on the left, and the finished task or project a
 *  row picks opens beside it — looking something up never leaves the Logbook. A phone has no
 *  room for two panes, so under touch a row pushes onto the shell's stack instead (Back returns
 *  here): through the nav context in the mobile-web shell, through its own handlers in the
 *  native one.
 *
 *  Its task rows multiselect like the tasks list's (cmd/shift-click, then Move to… or Delete from
 *  the bar over the pane). Project rows stay single-select, as repeating definitions do in the
 *  task lists: a selection is one kind of thing, so the bulk actions know what they act on. */
export function LogbookScreen({ onOpenTask, onOpenProject }: { onOpenTask?: (id: string) => void; onOpenProject?: (id: string) => void }) {
  const nav = useContext(NavContext);
  const tasks = useTasks();
  const { completedProjects, loading } = useProjects();
  const touch = useDensity() === "touch";
  const [limit, setLimit] = useState(PAGE);
  // What the split view's detail pane shows. Local to this screen, not a route: the Logbook
  // is a place to look things up, and the row stays picked only while it is open.
  const [selected, setSelected] = useState<{ kind: Entry["kind"]; id: string } | null>(null);

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    for (const task of tasks.tasks) {
      if (task.status !== "done") continue;
      // A done task always carries completedAt; a row from before that was kept falls back.
      const at = new Date(task.completedAt ?? task.updatedAt);
      if (!Number.isNaN(at.getTime())) out.push({ kind: "task", id: task.id, at, task });
    }
    for (const project of completedProjects) {
      const at = new Date(project.completedAt ?? project.updatedAt);
      if (!Number.isNaN(at.getTime())) out.push({ kind: "project", id: project.id, at, project });
    }
    return out.sort((a, b) => b.at.getTime() - a.at.getTime());
  }, [tasks.tasks, completedProjects]);

  const groups = useMemo(() => groupByDate(entries.slice(0, limit), (e) => e.at, "past"), [entries, limit]);

  // Announce the task rows, in the order shown, so range-select matches the screen. Only with a
  // pointer (a phone has no modifier keys) and only while this tab is the one showing —
  // background tabs stay mounted and would fight for the scope.
  const ms = useOptionalMultiSelect();
  const register = ms?.register;
  const visible = nav?.visible ?? true;
  useEffect(() => {
    if (touch || !visible) return;
    register?.("logbook", "task", groups.flatMap((g) => g.items).filter((e) => e.kind === "task").map((e) => e.id));
  }, [register, groups, touch, visible]);

  if (tasks.loading || loading) return <Spinner label="Opening the Logbook…" />;

  const open = (e: Entry, event?: GestureResponderEvent) => {
    if (!touch) {
      // A cmd/shift-click on a task row builds the selection instead of opening it; a project
      // row is outside it, so picking one lets it go.
      if (e.kind === "project") ms?.clear();
      else if (ms?.press(e.id, pressMods(event))) return;
      setSelected({ kind: e.kind, id: e.id });
    } else if (e.kind === "task") (onOpenTask ?? nav?.openTask)?.(e.id);
    else (onOpenProject ?? nav?.openProject)?.(e.id);
  };
  const renderEntry = (e: Entry, isLast: boolean) => (
    <LogbookRow
      key={`${e.kind}:${e.id}`}
      entry={e}
      touch={touch}
      divider={touch && !isLast}
      selected={!touch && (ms?.active ? e.kind === "task" && ms.isSelected(e.id) : selected?.kind === e.kind && selected.id === e.id)}
      onOpen={(event) => open(e, event)}
      onReopen={e.kind === "task" ? () => void tasks.setStatus(e.id, "open") : undefined}
    />
  );
  const older = entries.length > limit ? (
    <View style={styles.more}>
      <Button label={`Show older · ${entries.length - limit} more`} variant="secondary" size="sm" onPress={() => setLimit((n) => n + PAGE)} />
    </View>
  ) : null;

  if (entries.length === 0) {
    return (
      <View style={styles.empty}>
        <Icon name="logbook" size={icon.tile} color={colors.textQuaternary} />
        <Text variant="caption" tone="tertiary" style={styles.emptyText}>
          Nothing finished yet. Completed tasks and projects are kept here, by the day you finished them.
        </Text>
      </View>
    );
  }

  if (touch) {
    return (
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.touchPage}>
        {groups.map((g) => (
          <View key={g.key}>
            <DateGroupHeading label={g.label} count={g.items.length} />
            <View style={styles.card}>{g.items.map((e, i) => renderEntry(e, i === g.items.length - 1))}</View>
          </View>
        ))}
        {older}
      </ScrollView>
    );
  }

  return (
    <SplitView
      storageKey="companion.logbook.listWidth"
      defaultWidth={340}
      minWidth={240}
      maxWidth={520}
      aside={
        <View style={styles.root}>
          <View style={styles.header}>
            <Text variant="label">Logbook</Text>
            <Text variant="mono" tone="quaternary" style={{ flex: 1 }}>
              {entries.length} completed
            </Text>
          </View>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.list}>
            {groups.map((g) => (
              <View key={g.key}>
                <DateGroupHeading label={g.label} count={g.items.length} />
                {g.items.map((e) => renderEntry(e, false))}
              </View>
            ))}
            {older}
          </ScrollView>
        </View>
      }
    >
      {ms?.active && visible ? <LogbookSelection ms={ms} /> : <LogbookDetail selected={selected} onOpenTask={(id) => setSelected({ kind: "task", id })} />}
    </SplitView>
  );
}

/** The pane while several tasks are selected: the bulk bar over the selection stack, the first
 *  selected task on top — the same as the tasks list's. */
function LogbookSelection({ ms }: { ms: MultiSelectStore }) {
  const tasks = useTasks();
  const task = ms.primaryId ? tasks.byId(ms.primaryId) : undefined;
  return (
    <View style={styles.detail}>
      <MultiSelectBar />
      <SelectionStack count={ms.count}>
        {task ? (
          <TaskEditor key={task.id} task={task} save={tasks.update} />
        ) : (
          <Center>
            <Text tone="tertiary">Nothing to preview.</Text>
          </Center>
        )}
      </SelectionStack>
    </View>
  );
}

/** The split view's right pane: the picked task in its editor, the picked project on its
 *  overview page — or a prompt to pick one. Both are the real thing, not a preview: a task can
 *  be unticked or edited, a project reopened, right here. Once that takes it out of the
 *  Logbook the pane keeps showing it (it was opened on purpose) until another row is picked. */
function LogbookDetail({ selected, onOpenTask }: { selected: { kind: Entry["kind"]; id: string } | null; onOpenTask: (id: string) => void }) {
  const nav = useContext(NavContext);
  const tasks = useTasks();
  if (!selected) {
    return (
      <Center>
        <Text variant="caption" tone="tertiary" style={styles.emptyText}>
          Pick something from the Logbook to look back at it.
        </Text>
      </Center>
    );
  }
  if (selected.kind === "project") return <LogbookProject key={selected.id} projectId={selected.id} onOpenTask={onOpenTask} />;
  const task = tasks.byId(selected.id);
  if (!task) {
    return (
      <Center>
        <Text tone="tertiary">This task is gone.</Text>
      </Center>
    );
  }
  return (
    <View style={styles.detail}>
      <TaskEditor key={task.id} task={task} save={tasks.update} onPopOut={nav ? (id) => nav.openInNewTab({ kind: "task", id }) : undefined} onDelete={(id) => tasks.remove(id)} />
    </View>
  );
}

/** A completed project's overview page, in the pane: its completion banner (with Reopen), its
 *  description, and what it held. "View all" has no section list to go to in here, so it opens
 *  the project itself. */
function LogbookProject({ projectId, onOpenTask }: { projectId: string; onOpenTask: (id: string) => void }) {
  const nav = useContext(NavContext);
  const { projectById } = useProjects();
  const container = useMemo(() => ({ kind: "project" as const, id: projectId }), [projectId]);
  const { members, notes, tasks, canvases, projectOf } = useContainerContent(container);
  const project = projectById(projectId);
  if (!project) {
    return (
      <Center>
        <Text tone="tertiary">This project is gone.</Text>
      </Center>
    );
  }
  return (
    <View style={styles.detail}>
      <ContainerHome
        container={container}
        page={project}
        notes={notes}
        tasks={tasks}
        canvases={canvases}
        members={members}
        projectOf={projectOf}
        sections={["notes", "tasks", "canvases"]}
        onViewTasks={() => nav?.openProjectSection(projectId, "tasks")}
        // One of its tasks opens in this same pane: looking back never leaves the Logbook.
        onOpenTask={onOpenTask}
      />
    </View>
  );
}

/** One finished thing: a ticked box (untick to reopen the task) or the project's glyph, its
 *  name, and when it was completed. */
function LogbookRow({
  entry,
  touch,
  divider,
  selected,
  onOpen,
  onReopen,
}: {
  entry: Entry;
  touch: boolean;
  divider: boolean;
  selected: boolean;
  onOpen: (event: GestureResponderEvent) => void;
  onReopen?: () => void;
}) {
  const name = entry.kind === "task" ? entry.task.title || "Untitled task" : entry.project.name;
  return (
    <Pressable
      aria-label={name}
      onPress={onOpen}
      style={({ hovered, pressed }: PressState) => [
        styles.row,
        touch ? styles.rowTouch : null,
        divider ? styles.rowDivider : null,
        transition("background-color", motion.instant),
        { backgroundColor: selected ? colors.surfaceSelected : pressed ? colors.surfaceActive : hovered ? colors.surfaceHover : "transparent" },
      ]}
    >
      {entry.kind === "task" ? (
        <Checkbox checked onPress={() => onReopen?.()} />
      ) : entry.project.icon ? (
        <Text style={styles.emoji}>{entry.project.icon}</Text>
      ) : (
        <Icon name="folder" size={icon.sm} color={entry.project.color ?? colors.textQuaternary} />
      )}
      <Text variant="label" tone={selected ? "accent" : entry.kind === "task" ? "secondary" : "default"} numberOfLines={1} style={styles.rowTitle}>
        {name}
      </Text>
      <Text variant="mono" tone="quaternary" numberOfLines={1}>
        {entry.kind === "project" ? "project · " : ""}
        {completedLabel(entry.at)}
      </Text>
    </Pressable>
  );
}

/** "14:05" for today and yesterday (the group already says the day), else "Sep 12" — with the
 *  year once it isn't this one. */
function completedLabel(at: Date): string {
  const now = new Date();
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()) / 86400000);
  if (days <= 1) return at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return at.toLocaleDateString(undefined, at.getFullYear() === now.getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

const styles = {
  root: { flex: 1, minHeight: 0, backgroundColor: colors.surfaceCard },
  detail: { flex: 1, minWidth: 0, minHeight: 0, backgroundColor: colors.surfaceCard },
  header: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    height: layout.subToolbarH,
    paddingLeft: space.ml,
    paddingRight: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    flexShrink: 0,
  },
  list: { padding: space.xs, paddingBottom: space.xl, gap: 1 },
  row: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.sm,
    minHeight: row.h,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
  },
  rowTouch: { minHeight: 52, gap: space.ml, paddingHorizontal: space.ml, borderRadius: 0 },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  rowTitle: { flex: 1, minWidth: 0 },
  emoji: { fontSize: 13, lineHeight: 16, width: 16, textAlign: "center" as const },
  more: { alignItems: "center" as const, paddingVertical: space.lg },
  empty: { flex: 1, alignItems: "center" as const, justifyContent: "center" as const, gap: space.md, padding: space.xxl },
  emptyText: { textAlign: "center" as const, maxWidth: 320, lineHeight: 18 },
  touchPage: { padding: space.xl, paddingTop: space.sm, flexGrow: 1 },
  card: {
    backgroundColor: colors.surfaceCard,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    overflow: "hidden" as const,
  },
};
