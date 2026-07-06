import { useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import type { Task, UpdateTaskInput } from "@companion/core-bridge";
import { Icon, IconButton, Input, Text, TextField, colors, layout, radius, space, type IconName, type PressState } from "@companion/design-system";
import { useCore } from "./CoreContext";
import { DateTimeInput } from "./DateTimeInput";
import { TaskGraph } from "./TaskGraph";
import { MembershipPicker } from "./MembershipPicker";
import { ConfirmDialog } from "./ConfirmDialog";

export interface TaskEditorProps {
  task: Task;
  /** Persist a partial change (wired to TasksProvider.update). */
  save: (id: string, fields: UpdateTaskInput) => void;
  /** Shown as a delete (→ Trash) action when provided. */
  onDelete?: (id: string) => void;
  /** Render the built-in sub-toolbar (projects + delete) and its overlays. Desktop keeps
   *  it; mobile turns it off and hosts those actions in the nav header instead. */
  showToolbar?: boolean;
}

/** The detail editor for a single task (PLAN §6.4): a status checkbox, title, quick due /
 *  reminder presets, freeform notes (markdown — scanned for wikilinks), and project
 *  membership. Keyed by task id upstream so each task gets a fresh instance. */
export function TaskEditor({ task, save, onDelete, showToolbar = true }: TaskEditorProps) {
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notesMd);
  const [showProjects, setShowProjects] = useState(false);
  const [showGraph, setShowGraph] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Which metadata field has its full editor expanded (Reminders-style: the chips are the
  // resting state; tapping one reveals the natural-language / preset / picker controls).
  const [expanded, setExpanded] = useState<null | "due" | "reminder">(null);
  const done = task.status === "done";

  // Debounce text saves so every keystroke doesn't hit the store (and churn sync).
  const timers = useRef<{ title?: ReturnType<typeof setTimeout>; notes?: ReturnType<typeof setTimeout> }>({});
  const debouncedSave = (field: "title" | "notes", fields: UpdateTaskInput) => {
    if (timers.current[field]) clearTimeout(timers.current[field]);
    timers.current[field] = setTimeout(() => save(task.id, fields), 400);
  };

  const toggleDone = () => save(task.id, { status: done ? "open" : "done" });

  return (
    <View style={{ flex: 1 }}>
      {showToolbar ? (
        <View style={styles.subToolbar}>
          <View style={{ flex: 1 }} />
          <IconButton label="Add to projects" size="sm" onPress={() => setShowProjects(true)}>
            <Icon name="folder" size={16} color={colors.textTertiary} />
          </IconButton>
          <IconButton label={showGraph ? "Show task" : "Show task graph"} size="sm" active={showGraph} onPress={() => setShowGraph((v) => !v)}>
            <Icon name="graph" size={16} color={showGraph ? colors.accentHover : colors.textTertiary} />
          </IconButton>
          {onDelete ? (
            <IconButton label="Delete task" size="sm" onPress={() => setConfirmDelete(true)}>
              <Icon name="trash" size={16} color={colors.textTertiary} />
            </IconButton>
          ) : null}
        </View>
      ) : null}

      {showGraph ? (
        // RNW View is position:relative, giving the absolutely-filled graph canvas a size.
        <View style={{ flex: 1 }}>
          <TaskGraph taskId={task.id} />
        </View>
      ) : (
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.doc}>
        <View style={styles.titleRow}>
          <Checkbox checked={done} onPress={toggleDone} />
          <View style={{ flex: 1 }}>
            <TextField
              variant="title"
              value={title}
              placeholder="Task title"
              onChangeText={(t) => {
                setTitle(t);
                debouncedSave("title", { title: t });
              }}
            />
          </View>
        </View>

        {/* Metadata reads as a row of chips under the title; a chip expands its editor. */}
        <View style={styles.metaRow}>
          <MetaChip
            icon="calendar"
            label="Add due date"
            display={task.dueAt ? formatDue(task.dueAt) : null}
            tone={overdue(task) ? "accent" : "default"}
            active={expanded === "due"}
            onPress={() => setExpanded((e) => (e === "due" ? null : "due"))}
            onClear={task.dueAt ? () => save(task.id, { clearDueAt: true }) : undefined}
          />
          <MetaChip
            icon="bell"
            label="Add reminder"
            display={task.remindAt ? formatReminder(task.remindAt) : null}
            active={expanded === "reminder"}
            onPress={() => setExpanded((e) => (e === "reminder" ? null : "reminder"))}
            onClear={task.remindAt ? () => save(task.id, { clearRemindAt: true }) : undefined}
          />
        </View>

        {expanded === "due" ? (
          <View style={styles.metaEditor}>
            <DateRow
              value={task.dueAt}
              onSet={(iso) => save(task.id, { dueAt: iso })}
              onClear={() => save(task.id, { clearDueAt: true })}
              presets={duePresets()}
              nlPlaceholder="Type a date, e.g. next friday"
            />
          </View>
        ) : null}

        {expanded === "reminder" ? (
          <View style={styles.metaEditor}>
            <DateRow
              value={task.remindAt}
              onSet={(iso) => save(task.id, { remindAt: iso })}
              onClear={() => save(task.id, { clearRemindAt: true })}
              presets={reminderPresets()}
              nlPlaceholder="Type a time, e.g. tomorrow at 9am"
            />
          </View>
        ) : null}

        <TextField
          variant="prose"
          multiline
          value={notes}
          placeholder="Notes… use [[ to link a note."
          onChangeText={(t) => {
            setNotes(t);
            debouncedSave("notes", { notesMd: t });
          }}
        />
      </ScrollView>
      )}

      {showProjects ? (
        <MembershipPicker entityType="task" entityId={task.id} onClose={() => setShowProjects(false)} />
      ) : null}

      {onDelete && confirmDelete ? (
        <ConfirmDialog
          title="Delete task?"
          message="This task moves to the Trash and is permanently deleted after 30 days. You can restore it from the Trash until then."
          confirmLabel="Delete task"
          onConfirm={() => onDelete(task.id)}
          onClose={() => setConfirmDelete(false)}
        />
      ) : null}
    </View>
  );
}

/** A checkbox that renders a task's done state. */
export function Checkbox({ checked, onPress, size = 22 }: { checked: boolean; onPress: () => void; size?: number }) {
  return (
    <Pressable onPress={onPress} aria-label={checked ? "Mark not done" : "Mark done"} style={[styles.check, { width: size, height: size }, checked ? styles.checkOn : null]}>
      {checked ? <Icon name="check" size={size - 8} color={colors.gray0} /> : null}
    </Pressable>
  );
}

/** A metadata chip under the task title (Reminders-style). Empty shows a ghost "Add …"
 *  affordance; set shows the value with a clear (✕) button. Tapping the body expands the
 *  field's full editor upstream. */
function MetaChip({
  icon,
  label,
  display,
  tone = "default",
  active,
  onPress,
  onClear,
}: {
  icon: IconName;
  label: string;
  display: string | null;
  tone?: "default" | "accent";
  active: boolean;
  onPress: () => void;
  onClear?: () => void;
}) {
  const filled = display !== null;
  const accent = filled && tone === "accent";
  const iconColor = accent ? colors.accentHover : filled ? colors.textSecondary : colors.textTertiary;
  return (
    <Pressable
      onPress={onPress}
      style={({ hovered }: PressState) => [
        styles.metaChip,
        filled ? styles.metaChipFilled : null,
        active ? styles.metaChipActive : null,
        hovered ? styles.metaChipHover : null,
      ]}
    >
      <Icon name={icon} size={13} color={iconColor} />
      <Text variant="caption" tone={accent ? "accent" : filled ? "secondary" : "tertiary"}>
        {display ?? label}
      </Text>
      {filled && onClear ? (
        <Pressable onPress={onClear} aria-label="Clear" style={styles.metaChipClear}>
          <Icon name="close" size={11} color={colors.textTertiary} />
        </Pressable>
      ) : null}
    </Pressable>
  );
}

/** A compact task list row: checkbox, title (struck through when done), and a due chip.
 *  Shared by the global Tasks list and a project's Tasks section. */
export function TaskRow({
  task,
  selected,
  onPress,
  onToggle,
}: {
  task: Task;
  selected?: boolean;
  onPress: () => void;
  onToggle: () => void;
}) {
  const done = task.status === "done";
  return (
    <Pressable
      onPress={onPress}
      style={({ hovered }: PressState) => [
        styles.taskRow,
        { backgroundColor: selected ? colors.accentSoft : hovered ? colors.surfaceHover : "transparent" },
      ]}
    >
      <Checkbox checked={done} onPress={onToggle} size={18} />
      <Text numberOfLines={1} style={[{ flex: 1 }, done ? styles.doneTitle : null]}>
        {task.title || "Untitled task"}
      </Text>
      {task.dueAt ? (
        <Text variant="caption" tone={overdue(task) ? "accent" : "tertiary"}>
          {formatDueShort(task.dueAt)}
        </Text>
      ) : null}
    </Pressable>
  );
}

function overdue(task: Task): boolean {
  return task.status !== "done" && !!task.dueAt && new Date(task.dueAt).getTime() < Date.now();
}

function formatDueShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Chip label for a due date — "Jul 5" (adds the year when it isn't the current one). */
function formatDue(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
}

/** Chip label for a reminder — the due date plus a time ("Jul 5, 9:00 AM"). */
function formatReminder(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${formatDue(iso)}, ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

/** The full date control: current value, a natural-language field (parsed in core via
 *  olebedev/when), a concrete date/time picker (web), and quick-set presets. */
function DateRow({
  value,
  presets,
  onSet,
  onClear,
  nlPlaceholder,
}: {
  value?: string | null;
  presets: { label: string; at: () => Date }[];
  onSet: (iso: string) => void;
  onClear: () => void;
  nlPlaceholder: string;
}) {
  const { dates } = useCore();
  const [nl, setNl] = useState("");
  const [failed, setFailed] = useState(false);

  const submitNl = async () => {
    const text = nl.trim();
    if (!text) return;
    const parsed = await dates.parse(text);
    if (parsed) {
      onSet(parsed.at);
      setNl("");
      setFailed(false);
    } else {
      setFailed(true);
    }
  };

  return (
    <View style={{ gap: space.sm }}>
      {/* The picker is the display: it both shows the current value and edits it. The NL
          field sits beside it for typing a date in words. */}
      <View style={styles.inputRow}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Input
            size="sm"
            placeholder={nlPlaceholder}
            value={nl}
            onChangeText={(t) => {
              setNl(t);
              setFailed(false);
            }}
            onSubmitEditing={() => void submitNl()}
            leadingIcon={<Icon name="calendar" size={14} color={colors.textTertiary} />}
          />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <DateTimeInput value={value} onSet={onSet} />
        </View>
        {value ? (
          <Pressable onPress={onClear} aria-label="Clear" style={styles.clearBtn}>
            <Icon name="close" size={14} color={colors.textTertiary} />
          </Pressable>
        ) : null}
      </View>
      {failed ? (
        <Text variant="caption" tone="tertiary">
          Couldn’t read a date from that — try “tomorrow 3pm” or use a preset.
        </Text>
      ) : null}

      <View style={styles.presets}>
        {presets.map((p) => (
          <Pressable key={p.label} onPress={() => onSet(p.at().toISOString())} style={styles.chip}>
            <Text variant="caption" tone="secondary">
              {p.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

// --- date presets & formatting -------------------------------------------

function atToday(hour: number): Date {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return d;
}
function atDaysFrom(days: number, hour: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function duePresets() {
  return [
    { label: "Today", at: () => atToday(17) },
    { label: "Tomorrow", at: () => atDaysFrom(1, 17) },
    { label: "In a week", at: () => atDaysFrom(7, 17) },
  ];
}
function reminderPresets() {
  return [
    { label: "In 1 hour", at: () => new Date(Date.now() + 60 * 60 * 1000) },
    { label: "Tonight 6pm", at: () => atToday(18) },
    { label: "Tomorrow 9am", at: () => atDaysFrom(1, 9) },
  ];
}

const styles = {
  subToolbar: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.xs,
    height: 44,
    paddingHorizontal: space.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    flexShrink: 0,
  },
  doc: { maxWidth: layout.contentMax, width: "100%" as const, marginHorizontal: "auto" as const, padding: space.xxl, gap: space.sm },
  titleRow: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: space.md },
  groupLabel: { fontWeight: "600" as const, letterSpacing: 0.5, marginTop: space.lg },
  // Chips + their expanded editors sit indented under the title (past the checkbox).
  metaRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: space.sm, marginTop: space.md, marginLeft: 22 + space.md },
  metaEditor: { marginLeft: 22 + space.md, marginTop: space.xs, marginBottom: space.xs },
  metaChip: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: 5,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: "transparent" as const,
  },
  metaChipFilled: { backgroundColor: colors.gray50, borderColor: colors.borderSubtle },
  metaChipActive: { backgroundColor: colors.accentSoft, borderColor: colors.accentSoftBorder },
  metaChipHover: { borderColor: colors.borderDefault },
  metaChipClear: { marginLeft: 1, padding: 3, marginVertical: -3, marginRight: -3 },
  inputRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm },
  clearBtn: { padding: 2 },
  presets: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: space.sm },
  chip: { paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.full, borderWidth: 1, borderColor: colors.borderDefault },
  check: {
    borderRadius: radius.full,
    borderWidth: 2,
    borderColor: colors.borderStrong,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    marginTop: 6,
    flexShrink: 0,
  },
  checkOn: { backgroundColor: colors.success, borderColor: colors.success },
  taskRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
  },
  doneTitle: { textDecorationLine: "line-through" as const, color: colors.textTertiary },
};
