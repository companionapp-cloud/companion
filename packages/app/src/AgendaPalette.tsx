import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import type { ProjectMember, Task } from "@companion/core-bridge";
import { Icon, Kbd, ListRow, Text, colors, font, icon, radius, shadow, space, useDensity, type IconName } from "@companion/design-system";
import { paletteEnter } from "./paletteEnter";
import { Overlay } from "./Overlay";
import { useProjects } from "./ProjectsProvider";

// The agenda's command palette (PLAN-agenda.md): what a click on an empty quarter hour — or
// the search button over the agenda — opens. One input: type to find a task you already have,
// listed under its area and project, or to name something new; ⏎ puts it at that time. A
// sibling of the app's command palette, cut down to the one question "what goes here?".

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");
const clock = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
/** 'due 25 Sep', for a task that has a deadline. */
function dueLabel(task: Task): string | undefined {
  if (!task.dueAt) return undefined;
  const d = new Date(task.dueAt);
  return `due ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}

interface Row {
  key: string;
  section: string;
  icon: IconName;
  title: string;
  trailing?: string;
  /** `stay` (⇧⏎) keeps the palette open for the next pick, where that makes sense. */
  run: (stay: boolean) => void;
  /** Whether ⇧⏎ means anything on this row. */
  repeatable?: boolean;
}

/** Where every filed task lives: task id → its membership (a project's, or an area's). One
 *  tree read per area; a task in no container is simply absent. */
function useTaskContainers(): Map<string, ProjectMember> {
  const { areas, membershipsForArea } = useProjects();
  const [byTask, setByTask] = useState<Map<string, ProjectMember>>(() => new Map());
  useEffect(() => {
    let alive = true;
    void Promise.all(areas.map((a) => membershipsForArea(a.id, true).catch(() => [] as ProjectMember[]))).then((lists) => {
      if (!alive) return;
      const next = new Map<string, ProjectMember>();
      for (const m of lists.flat()) if (m.entityType === "task" && !m.deletedAt) next.set(m.entityId, m);
      setByTask(next);
    });
    return () => {
      alive = false;
    };
  }, [areas, membershipsForArea]);
  return byTask;
}

export function AgendaPalette({
  block,
  candidates,
  canAddEvent,
  onPickTask,
  onNewTask,
  onNewEvent,
  onClose,
}: {
  /** The time whatever is chosen will take. */
  block: { startsAt: string; endsAt: string };
  /** The open tasks that aren't on the day already. */
  candidates: Task[];
  /** A writable calendar is connected. */
  canAddEvent: boolean;
  onPickTask: (task: Task) => void;
  onNewTask: (title: string) => void;
  /** Opens the event editor at `block`, its title seeded with what was typed. */
  onNewEvent: (title: string) => void;
  onClose: () => void;
}) {
  const { areas, projectById } = useProjects();
  const containers = useTaskContainers();
  const touch = useDensity() === "touch";
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const when = `${clock(block.startsAt)}–${clock(block.endsAt)}`;

  const rows = useMemo(() => {
    const q = query.trim();
    const needle = q.toLowerCase();
    const out: Row[] = [];
    if (canAddEvent) {
      out.push({ key: "new-event", section: "Create", icon: "calendar", title: q ? `New event “${q}”` : "New event", trailing: when, run: () => onNewEvent(q) });
    }
    if (q) out.push({ key: "new-task", section: "Create", icon: "plus", title: `New task “${q}”`, trailing: when, run: () => onNewTask(q) });

    // Existing tasks, under where they live: unsorted first (the inbox), then each area in
    // sidebar order — what is filed in the area itself, then its projects. A query matches a
    // task's title, or the name of its project or area (so "launch" lists the whole project).
    const areaOrder = new Map(areas.map((a, i) => [a.id, i]));
    const groups = new Map<string, { order: [number, number, string]; label: string; tasks: Task[] }>();
    for (const task of candidates) {
      const m = containers.get(task.id);
      const project = m && m.containerType !== "area" ? projectById(m.projectId) : undefined;
      const area = areas.find((a) => a.id === (project ? project.areaId : m?.projectId));
      const label = area ? (project ? `${area.name} › ${project.name}` : area.name) : project ? project.name : "Unsorted";
      if (needle && !task.title.toLowerCase().includes(needle) && !label.toLowerCase().includes(needle)) continue;
      const order: [number, number, string] = [area ? (areaOrder.get(area.id) ?? 0) + 1 : 0, project ? project.sortOrder + 1 : 0, label];
      const group = groups.get(label) ?? { order, label, tasks: [] };
      group.tasks.push(task);
      groups.set(label, group);
    }
    const sorted = [...groups.values()].sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.order[2].localeCompare(b.order[2]));
    for (const g of sorted) {
      for (const task of g.tasks) {
        out.push({ key: task.id, section: g.label, icon: "tasks", title: task.title || "Untitled task", trailing: dueLabel(task), run: () => onPickTask(task), repeatable: true });
      }
    }
    return out;
  }, [query, candidates, containers, areas, projectById, canAddEvent, when, onNewEvent, onNewTask, onPickTask]);

  // Typing lands on the first task that matches, not on "New event" above it: finding is the
  // common case, and creating is one ↑ away (or the only thing left when nothing matches).
  useEffect(() => {
    const firstTask = rows.findIndex((r) => r.repeatable);
    setSelected(query.trim() && firstTask >= 0 ? firstTask : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);
  const at = Math.min(selected, Math.max(0, rows.length - 1));

  const run = (row: Row | undefined, stay: boolean) => {
    if (!row) return;
    row.run(stay);
    if (!(stay && row.repeatable)) onClose();
  };

  // Capture phase, so the palette's keys win over the focused input.
  const latest = useRef({ rows, at, run, onClose });
  latest.current = { rows, at, run, onClose };
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      const { rows: list, at: i, run: go, onClose: close } = latest.current;
      const take = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        take();
        if (list.length) setSelected((i + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length);
      } else if (e.key === "Enter" && !e.isComposing) {
        take();
        go(list[i], e.shiftKey);
      } else if (e.key === "Escape") {
        take();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Keep the selected row in view as the arrows walk past the fold.
  const rowNodes = useRef(new Map<number, unknown>());
  useEffect(() => {
    const node = rowNodes.current.get(at) as { scrollIntoView?: (o: { block: string }) => void } | undefined;
    node?.scrollIntoView?.({ block: "nearest" });
  }, [at]);

  const panel = (
    <View style={styles.layer}>
      <Pressable style={styles.scrim} onPress={onClose} aria-label="Close" />
      <View style={[styles.panel, paletteEnter]}>
        <View style={styles.inputRow}>
          <Icon name="search" size={icon.lg} color={colors.textTertiary} />
          <View style={styles.chip}>
            <Text variant="label" tone="accent">
              {when}
            </Text>
          </View>
          <TextInput
            value={query}
            onChangeText={setQuery}
            // Native has no key listener above; the keyboard's return key runs the selection.
            onSubmitEditing={() => run(rows[at], false)}
            placeholder={canAddEvent ? "Find a task, or name a new task or event…" : "Find a task, or name a new one…"}
            placeholderTextColor={colors.textQuaternary}
            autoFocus
            autoCapitalize="none"
            style={styles.input}
          />
        </View>
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {rows.map((r, i) => (
            <View key={r.key}>
              {i === 0 || rows[i - 1].section !== r.section ? (
                <Text variant="mono" tone="quaternary" style={styles.section} numberOfLines={1}>
                  {r.section.toLowerCase()}
                </Text>
              ) : null}
              <View
                ref={(node: unknown) => {
                  if (node) rowNodes.current.set(i, node);
                  else rowNodes.current.delete(i);
                }}
                onPointerMove={() => {
                  if (at !== i) setSelected(i);
                }}
              >
                <ListRow
                  title={r.title}
                  trailing={r.trailing}
                  selected={i === at}
                  icon={<Icon name={r.icon} size={icon.sm} color={i === at ? colors.textAccent : colors.textQuaternary} />}
                  // A shift-click is ⇧⏎: the press carries the DOM event's modifiers on web.
                  onPress={(e) => run(r, !!(e?.nativeEvent as { shiftKey?: boolean } | undefined)?.shiftKey)}
                />
              </View>
            </View>
          ))}
          {rows.length === 0 ? (
            <Text variant="caption" tone="tertiary" style={styles.empty}>
              No open tasks to add. Type a name to make a new one.
            </Text>
          ) : null}
        </ScrollView>
        {/* Key hints, where there are keys. */}
        {Platform.OS === "web" && !touch ? (
          <View style={styles.footer}>
            <Hint keys="↑↓" label="move" />
            <Hint keys="⏎" label={rows[at]?.repeatable ? "add" : "create"} />
            {rows[at]?.repeatable ? <Hint keys="⇧⏎" label="add, keep open" /> : null}
            <View style={{ flex: 1 }} />
            <Hint keys="esc" label="close" />
          </View>
        ) : null}
      </View>
    </View>
  );

  if (Platform.OS === "web") return <Overlay>{panel}</Overlay>;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      {panel}
    </Modal>
  );
}

function Hint({ keys, label }: { keys: string; label: string }) {
  return (
    <View style={styles.hint}>
      <Kbd>{keys}</Kbd>
      <Text variant="mono" tone="quaternary">
        {label}
      </Text>
    </View>
  );
}

const web = Platform.OS === "web";

const styles = StyleSheet.create({
  // Portaled to document.body on web, so `fixed` pins it to the viewport above every pane.
  layer: { position: (web ? "fixed" : "absolute") as "absolute", top: 0, right: 0, bottom: 0, left: 0, alignItems: "center", zIndex: 1000 },
  scrim: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.scrim },
  // The app palette's card, a size down.
  panel: {
    width: 520,
    maxWidth: "92%",
    maxHeight: (web ? "72vh" : "72%") as unknown as number,
    marginTop: (web ? "14vh" : 72) as unknown as number,
    overflow: "hidden",
    backgroundColor: colors.surfaceOverlay,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.xl,
    ...shadow.lg,
  },
  inputRow: { flexDirection: "row", alignItems: "center", gap: space.md, height: 44, paddingHorizontal: space.lg, flexShrink: 0 },
  chip: { flexShrink: 0, paddingHorizontal: space.sm, paddingVertical: space.xxs, borderRadius: radius.sm, backgroundColor: colors.surfaceSelected },
  input: {
    flex: 1,
    minWidth: 0,
    padding: 0,
    height: 44,
    color: colors.textPrimary,
    fontFamily: font.sans,
    fontSize: font.size.lg,
    ...(web ? ({ outlineStyle: "none" } as Record<string, unknown>) : null),
  },
  list: { maxHeight: 340, flexShrink: 1, borderTopWidth: 1, borderTopColor: colors.borderSubtle },
  listContent: { padding: space.sm, gap: 1 },
  section: { paddingHorizontal: space.sm, paddingTop: space.md, paddingBottom: space.xs },
  empty: { paddingHorizontal: space.sm, paddingVertical: space.lg },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.lg,
    paddingHorizontal: space.lg,
    height: 32,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    flexShrink: 0,
  },
  hint: { flexDirection: "row", alignItems: "center", gap: space.xs },
});
