import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, TextInput, View, type GestureResponderEvent } from "react-native";
import type { Task, TaskReminder, UpdateTaskInput } from "@companion/core-bridge";
import {
  Badge,
  Button,
  Icon,
  IconButton,
  Input,
  Text,
  colors,
  control,
  font,
  layout,
  motion,
  radius,
  row,
  space,
  transition,
  useDensity,
  type IconName,
  type PressState,
} from "@companion/design-system";
import { Editor, type EditorController, type LinkRef } from "@companion/editor";
import { useCore } from "./CoreContext";
import { useTasks } from "./TasksProvider";
import { useSync } from "./SyncProvider";
import { REPEAT_PRESETS, repeatLabel } from "./repeat";
import { MAX_REMINDERS, REMINDER_LEAD_PRESETS, reminderLabel, remindersSummary, sameReminder } from "./reminders";
import { useLinkSource } from "./useLinkSource";
import { useQuickCreateLink } from "./useQuickCreateLink";
import { DateTimeInput } from "./DateTimeInput";
import { TaskGraph } from "./TaskGraph";
import { MembershipPicker } from "./MembershipPicker";
import { ArchetypeChip, ObjectMetadataPanel, MetadataSidePanel } from "./ArchetypeSection";
import { ConfirmDialog } from "./ConfirmDialog";
import { NavContext } from "./nav-context";
import { timeAgo } from "./NotificationRow";

export interface TaskEditorProps {
  task: Task;
  /** Persist a partial change (wired to TasksProvider.update). */
  save: (id: string, fields: UpdateTaskInput) => void;
  /** Shown as a delete (→ Trash) action when provided. */
  onDelete?: (id: string) => void;
  /** Shown as an "open in the workspace tab strip" action when provided (used from the
   *  project detail pane, which has no tabs of its own). */
  onPopOut?: (id: string) => void;
  /** Render the built-in sub-toolbar (projects + delete) and its overlays. Desktop keeps
   *  it; mobile turns it off and hosts those actions in the nav header instead. */
  showToolbar?: boolean;
  /** Open a wikilink chip the reader clicked in the notes (e.g. `[[note:…]]`). Omit and chips
   *  only select. */
  onOpenRef?: (ref: LinkRef) => void;
  /** Take the user to the sync/connect settings. Wired by each shell so the repeat editor's
   *  "repeats need a server" CTA can act (occurrences are generated server-side, §6.4). */
  onConnectSync?: () => void;
}

/** The detail editor for a single task (PLAN §6.4): a status checkbox, title, its start,
 *  deadline, reminders and repeat, freeform notes (markdown — scanned for wikilinks), and
 *  project membership. Keyed by task id upstream so each task gets a fresh instance. */
export function TaskEditor({ task, save, onDelete, onPopOut, showToolbar = true, onOpenRef, onConnectSync }: TaskEditorProps) {
  const tasks = useTasks();
  const linkSource = useLinkSource();
  const editorRef = useRef<EditorController>(null);
  // Empty `[[label]]` links in the notes double-click to a quick-create dialog.
  const quickCreate = useQuickCreateLink(editorRef);
  const [title, setTitle] = useState(task.title);
  const [showProjects, setShowProjects] = useState(false);
  const [showGraph, setShowGraph] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Toggle the object metadata side panel (desktop only — mobile shows it inline, since it
  // has no sub-toolbar to host the toggle).
  const [showMeta, setShowMeta] = useState(false);
  // Which metadata field has its full editor expanded (Reminders-style: the chips are the
  // resting state; tapping one reveals the natural-language / preset / picker controls).
  const [expanded, setExpanded] = useState<null | "start" | "deadline" | "reminders" | "repeat">(null);
  const toggle = (field: NonNullable<typeof expanded>) => setExpanded((e) => (e === field ? null : field));
  const done = task.status === "done";
  // Touch density (the mobile shells) keeps 44px chrome, `lg` controls and a 22px checkbox.
  const touch = useDensity() === "touch";
  // Selecting a task focuses its title — a task is usually renamed the moment it's opened.
  // Keyed by task id upstream, so this is autofocus-on-mount. Never on touch (it would pop
  // the keyboard) and never from a background tab; the focus view has no nav context and is
  // always the visible surface.
  const visible = useContext(NavContext)?.visible ?? true;
  const focusTitle = useRef(!touch && visible).current;
  // The checkbox is the editor's primary control, so it outgrows the 12px list box. Chips and
  // their editors sit indented past it.
  const checkSize = touch ? 22 : 18;
  const indent = { marginLeft: checkSize + space.md };
  const btn = touch ? undefined : ("sm" as const);
  const glyph = touch ? 17 : 13;

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
        <View style={[styles.subToolbar, touch ? styles.subToolbarTouch : null]}>
          <Badge tone={done ? "neutral" : "accent"} label={done ? "done" : "open"} />
          <Text variant="mono" tone="quaternary" numberOfLines={1}>
            edited {timeAgo(task.updatedAt)}
          </Text>
          <View style={{ flex: 1 }} />
          <IconButton label="Move to an area or project" size={btn} onPress={() => setShowProjects(true)}>
            <Icon name="folder" size={glyph} color={colors.textSecondary} />
          </IconButton>
          <IconButton label={showGraph ? "Show task" : "Show task graph"} size={btn} active={showGraph} onPress={() => setShowGraph((v) => !v)}>
            <Icon name="graph" size={glyph} color={showGraph ? colors.textAccent : colors.textSecondary} />
          </IconButton>
          <IconButton label={showMeta ? "Hide metadata" : "Show metadata"} size={btn} active={showMeta} onPress={() => setShowMeta((v) => !v)}>
            <Icon name="panelRight" size={glyph} color={showMeta ? colors.textAccent : colors.textSecondary} />
          </IconButton>
          {onPopOut ? (
            <IconButton label="Open in tab" size={btn} onPress={() => onPopOut(task.id)}>
              <Icon name="external" size={glyph} color={colors.textSecondary} />
            </IconButton>
          ) : null}
          {onDelete ? (
            <IconButton label="Delete task" size={btn} onPress={() => setConfirmDelete(true)}>
              <Icon name="trash" size={glyph} color={colors.textSecondary} />
            </IconButton>
          ) : null}
        </View>
      ) : null}

      {/* Content and the metadata side panel sit side by side; the panel is toggled. */}
      <View style={styles.body}>
      {showGraph ? (
        // RNW View is position:relative, giving the absolutely-filled graph canvas a size.
        <View style={{ flex: 1 }}>
          <TaskGraph taskId={task.id} />
        </View>
      ) : (
      <ScrollView style={{ flex: 1 }} contentContainerStyle={touch ? styles.pageTouch : styles.page}>
        <View style={styles.doc}>
        <View style={styles.titleRow}>
          {/* Level with the title's first line, however many lines it wraps to. */}
          <View style={{ marginTop: ((touch ? TITLE_LINE.touch : TITLE_LINE.pointer) - checkSize) / 2 }}>
            <Checkbox checked={done} onPress={toggleDone} size={checkSize} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <DocTitleField
              value={title}
              placeholder="Task title"
              autoFocus={focusTitle}
              onChangeText={(t) => {
                setTitle(t);
                debouncedSave("title", { title: t });
              }}
            />
          </View>
        </View>

        {/* Metadata reads as a row of chips under the title; a chip expands its editor. */}
        <View style={[styles.metaRow, indent]}>
          <MetaChip
            icon="calendar"
            label="Add start"
            display={task.startAt ? `starts ${formatWhen(task.startAt)}` : null}
            active={expanded === "start"}
            onPress={() => toggle("start")}
            onClear={task.startAt ? () => save(task.id, { clearStartAt: true }) : undefined}
          />
          <MetaChip
            icon="flag"
            label="Add deadline"
            display={task.dueAt ? formatWhen(task.dueAt) : null}
            tone={overdue(task) ? "danger" : dueToday(task) ? "accent" : "default"}
            active={expanded === "deadline"}
            onPress={() => toggle("deadline")}
            onClear={task.dueAt ? () => save(task.id, { clearDueAt: true }) : undefined}
          />
          <MetaChip
            icon="bell"
            label="Add reminder"
            display={remindersSummary(task.reminders)}
            active={expanded === "reminders"}
            onPress={() => toggle("reminders")}
            onClear={task.reminders?.length ? () => save(task.id, { reminders: [] }) : undefined}
          />
          <MetaChip
            icon="repeat"
            label="Repeat"
            display={repeatLabel(task.repeatRule)}
            active={expanded === "repeat"}
            onPress={() => toggle("repeat")}
            onClear={task.repeatRule ? () => save(task.id, { clearRepeatRule: true }) : undefined}
          />
          {/* The archetype type is set/cleared inline; its fields live in the metadata panel. */}
          <ArchetypeChip
            kind="task"
            objectTypeId={task.objectTypeId}
            onSetType={(typeId) => save(task.id, { objectTypeId: typeId })}
            onClearType={() => save(task.id, { clearObjectType: true, props: {} })}
          />
        </View>

        {expanded === "start" ? (
          <View style={[styles.metaEditor, indent, touch ? null : styles.narrow]}>
            <DateRow
              value={task.startAt}
              onSet={(iso) => save(task.id, { startAt: iso })}
              onClear={() => save(task.id, { clearStartAt: true })}
              presets={startPresets()}
              nlPlaceholder="Type a start, e.g. monday 9am"
            />
          </View>
        ) : null}

        {expanded === "deadline" ? (
          <View style={[styles.metaEditor, indent, touch ? null : styles.narrow]}>
            <DateRow
              value={task.dueAt}
              onSet={(iso) => save(task.id, { dueAt: iso })}
              onClear={() => save(task.id, { clearDueAt: true })}
              presets={deadlinePresets()}
              nlPlaceholder="Type a deadline, e.g. next friday"
            />
          </View>
        ) : null}

        {expanded === "reminders" ? (
          <View style={[styles.metaEditor, indent, touch ? null : styles.narrow]}>
            <RemindersRow
              task={task}
              onChange={(reminders) => save(task.id, { reminders })}
              onAddDeadline={() => setExpanded("deadline")}
            />
          </View>
        ) : null}

        {expanded === "repeat" ? (
          <View style={[styles.metaEditor, indent, touch ? null : styles.narrow]}>
            <RepeatRow
              task={task}
              onSet={(rule) => save(task.id, rule ? { repeatRule: rule } : { clearRepeatRule: true })}
              onConnectSync={onConnectSync}
            />
          </View>
        ) : null}

        {/* Structured props (PLAN §6.3). On desktop these live in the metadata side panel;
            mobile has no sub-toolbar to toggle it, so once a type is set we show them inline. */}
        {!showToolbar && task.objectTypeId ? (
          <View style={[styles.archetype, indent]}>
            <ObjectMetadataPanel
              objectTypeId={task.objectTypeId}
              props={task.props}
              onChangeProps={(next) => save(task.id, { props: next })}
            />
          </View>
        ) : null}

        {/* Notes read as a rounded input, left-aligned with the date / reminder fields above. */}
        <View style={[styles.notesField, indent, touch ? null : styles.narrow]}>
          <Editor
            ref={editorRef}
            variant="simple"
            markdown={task.notesMd}
            placeholder="Notes… use [[ to link a note."
            onChangeMarkdown={(md) => debouncedSave("notes", { notesMd: md })}
            linkSource={linkSource}
            onOpenRef={onOpenRef}
            onQuickCreate={quickCreate.onQuickCreate}
            // `tasks.tasks` gets a fresh identity when any task changes, re-hydrating chips.
            linkRevision={tasks.tasks}
            minHeight={88}
          />
        </View>
        </View>
      </ScrollView>
      )}

        {showMeta && showToolbar ? (
          <MetadataSidePanel
            objectTypeId={task.objectTypeId}
            props={task.props}
            onChangeProps={(next) => save(task.id, { props: next })}
            onClose={() => setShowMeta(false)}
          />
        ) : null}
      </View>

      {quickCreate.dialog}

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

/** Line heights of the document title, which the task checkbox lines up with. */
const TITLE_LINE = { pointer: 36, touch: 26 };

/** The document title: a borderless ("ghost") textarea, so a long title wraps onto more
 *  lines instead of scrolling out of view. It is still one line of text: Enter leaves the
 *  field (calling `onSubmit`, e.g. to move into the body) rather than adding a line break,
 *  and pasted line breaks become spaces. 30px display with a pointer, 20px on touch density
 *  (30px clips on a phone). Shared by the note and task editors, on web and native. */
export function DocTitleField({
  value,
  placeholder,
  autoFocus,
  onChangeText,
  onSubmit,
}: {
  value: string;
  placeholder: string;
  autoFocus?: boolean;
  onChangeText: (text: string) => void;
  /** Enter was pressed; the field blurs, and the host may move focus on. */
  onSubmit?: () => void;
}) {
  const touch = useDensity() === "touch";
  // On web this is the <textarea>.
  const node = useRef<unknown>(null);
  // A web textarea doesn't grow with its text, so it's sized to its content whenever the text
  // or the column's width changes. Native multiline inputs grow by themselves.
  useLayoutEffect(() => fitToContent(node.current), [value, touch]);
  useEffect(() => {
    const el = node.current as HTMLElement | null;
    if (Platform.OS !== "web" || !el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fitToContent(el);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <TextInput
      ref={(el: unknown) => {
        node.current = el;
      }}
      value={value}
      placeholder={placeholder}
      placeholderTextColor={colors.textQuaternary}
      autoFocus={autoFocus}
      multiline
      // One row to start (a web textarea otherwise opens two rows tall); native grows freely.
      numberOfLines={Platform.OS === "web" ? 1 : undefined}
      scrollEnabled={false}
      blurOnSubmit
      submitBehavior="blurAndSubmit"
      onSubmitEditing={() => onSubmit?.()}
      onChangeText={(t) => onChangeText(t.replace(/[\r\n]+/g, " "))}
      style={[styles.title, touch ? styles.titleTouch : styles.titlePointer]}
    />
  );
}

/** Size a web textarea to its content (a no-op on native). */
function fitToContent(node: unknown): void {
  if (Platform.OS !== "web" || !node) return;
  const el = node as HTMLTextAreaElement;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

/** A checkbox that renders a task's done state: 1px border-strong box, accent fill + white
 *  check when done. 12px in dense list rows, larger where it is a surface's primary control,
 *  22px on touch. `label` overrides the task-flavored accessibility label for non-task uses
 *  (e.g. settings toggles). */
export function Checkbox({ checked, onPress, size, label }: { checked: boolean; onPress: () => void; size?: number; label?: string }) {
  const touch = useDensity() === "touch";
  const dim = size ?? (touch ? 22 : 12);
  return (
    <Pressable
      onPress={onPress}
      aria-label={label ?? (checked ? "Mark not done" : "Mark done")}
      // Keep the hit target finger/pointer friendly even though the drawn box is small.
      hitSlop={touch ? 11 : 4}
      style={[
        styles.check,
        transition("background-color, border-color", motion.instant),
        { width: dim, height: dim, borderRadius: dim > 14 ? radius.sm : radius.xs },
        checked ? styles.checkOn : null,
      ]}
    >
      {checked ? <Icon name="check" size={Math.round(dim * 0.72)} color={colors.onAccent} strokeWidth={2.5} /> : null}
    </Pressable>
  );
}

/** A metadata chip under the task title. Empty shows a ghost "Add …" affordance; set shows
 *  the value (mono — it is a date or a rule) with a clear (✕) button. Tapping the body
 *  expands the field's full editor upstream. */
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
  tone?: "default" | "accent" | "danger";
  active: boolean;
  onPress: () => void;
  onClear?: () => void;
}) {
  const touch = useDensity() === "touch";
  const filled = display !== null;
  const toned = filled && tone !== "default";
  const iconColor = toned ? (tone === "danger" ? colors.danger : colors.textAccent) : filled ? colors.textSecondary : colors.textTertiary;
  return (
    <Pressable
      onPress={onPress}
      style={({ hovered, pressed }: PressState) => [
        styles.metaChip,
        touch ? styles.metaChipTouch : null,
        filled ? styles.metaChipFilled : null,
        hovered ? styles.metaChipHover : null,
        pressed ? styles.metaChipPressed : null,
        active ? styles.metaChipActive : null,
      ]}
    >
      <Icon name={icon} size={12} color={iconColor} />
      {filled ? (
        <Text variant="mono" tone={toned ? (tone === "danger" ? "danger" : "accent") : "secondary"}>
          {display}
        </Text>
      ) : (
        <Text variant="caption" tone="tertiary">
          {label}
        </Text>
      )}
      {filled && onClear ? (
        <Pressable onPress={onClear} aria-label="Clear" hitSlop={touch ? 10 : 3} style={styles.metaChipClear}>
          <Icon name="close" size={11} color={colors.textQuaternary} />
        </Pressable>
      ) : null}
    </Pressable>
  );
}

/** A compact task list row: checkbox, title (struck through when done), and a mono due
 *  label. 24px with a pointer, 44px on touch. Shared by the global Tasks list and a
 *  project's Tasks section. */
export function TaskRow({
  task,
  selected,
  onPress,
  onToggle,
  trailing,
}: {
  task: Task;
  selected?: boolean;
  onPress: (e: GestureResponderEvent) => void;
  onToggle: () => void;
  /** Optional trailing controls after the due label (e.g. a remove-from-list button). Shown
   *  only while the row is hovered, so a list of rows doesn't read as a wall of buttons;
   *  on touch (no hover) they stay visible. */
  trailing?: ReactNode;
}) {
  const touch = useDensity() === "touch";
  const done = task.status === "done";
  return (
    <Pressable
      onPress={onPress}
      style={({ hovered, pressed }: PressState) => [
        styles.taskRow,
        touch ? styles.taskRowTouch : null,
        transition("background-color", motion.instant),
        { backgroundColor: selected ? colors.surfaceSelected : pressed ? colors.surfaceActive : hovered ? colors.surfaceHover : "transparent" },
      ]}
    >
      {(({ hovered }: PressState) => (
        <>
          <Checkbox checked={done} onPress={onToggle} />
          <Text
            variant="label"
            tone={done ? "quaternary" : selected ? "accent" : "default"}
            numberOfLines={1}
            style={[styles.taskTitle, done ? styles.doneTitle : null]}
          >
            {task.title || "Untitled task"}
          </Text>
          {task.repeatSeedId ? <Icon name="repeat" size={12} color={colors.textQuaternary} /> : null}
          {task.dueAt ? (
            <Text variant="mono" tone={overdue(task) ? "danger" : dueToday(task) ? "accent" : "quaternary"}>
              {dueToday(task) ? "today" : formatDueShort(task.dueAt)}
            </Text>
          ) : startsLater(task) ? (
            <Text variant="mono" tone="quaternary">
              starts {formatDueShort(task.startAt!)}
            </Text>
          ) : null}
          {trailing ? <View style={{ opacity: hovered || !canHover ? 1 : 0 }}>{trailing}</View> : null}
        </>
      )) as unknown as ReactNode}
    </Pressable>
  );
}

// Hover only exists with a pointer; touch platforms keep hover-revealed controls visible.
const canHover = Platform.OS === "web" && typeof window !== "undefined" && !!window.matchMedia?.("(hover: hover)").matches;

function overdue(task: Task): boolean {
  return task.status !== "done" && !!task.dueAt && new Date(task.dueAt).getTime() < Date.now();
}

/** Due later today and not yet done. A time that has already passed is overdue instead. */
function dueToday(task: Task): boolean {
  if (task.status === "done" || !task.dueAt) return false;
  const d = new Date(task.dueAt);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate() && d.getTime() >= now.getTime();
}

/** Not yet started: a start in the future (and not done). Rows show it only when the task has
 *  no deadline to show instead. */
function startsLater(task: Task): boolean {
  return task.status !== "done" && !!task.startAt && new Date(task.startAt).getTime() > Date.now();
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

/** The natural-language echo — "Thu 17 Sep", plus the time when the phrase carried one. */
function formatEcho(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = `${d.toLocaleDateString(undefined, { weekday: "short" })} ${d.getDate()} ${d.toLocaleDateString(undefined, { month: "short" })}`;
  if (d.getHours() === 0 && d.getMinutes() === 0) return day;
  return `${day} · ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

/** Chip label for a start or deadline — "Jul 5, 5:00 PM", or just "Jul 5" at midnight (a
 *  date typed without a time). Relative reminders count back from the deadline's time, so
 *  the chip shows it. */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (d.getHours() === 0 && d.getMinutes() === 0) return formatDue(iso);
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
  const touch = useDensity() === "touch";
  const [nl, setNl] = useState("");
  const [failed, setFailed] = useState(false);
  // What the last typed phrase resolved to, echoed back as mono `→ Thu 17 Sep`.
  const [echo, setEcho] = useState<string | null>(null);

  const submitNl = async () => {
    const text = nl.trim();
    if (!text) return;
    const parsed = await dates.parse(text);
    if (parsed) {
      onSet(parsed.at);
      setNl("");
      setFailed(false);
      setEcho(formatEcho(parsed.at));
    } else {
      setFailed(true);
      setEcho(null);
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
              if (t) setEcho(null);
            }}
            onSubmitEditing={() => void submitNl()}
            leadingIcon={<Icon name="calendar" size={12} color={colors.textQuaternary} />}
          />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <DateTimeInput value={value} onSet={onSet} />
        </View>
        {value ? (
          <IconButton label="Clear" size={touch ? undefined : "sm"} onPress={onClear}>
            <Icon name="close" size={12} color={colors.textTertiary} />
          </IconButton>
        ) : null}
      </View>
      {echo ? (
        <Text variant="mono" tone="quaternary">
          → {echo}
        </Text>
      ) : null}
      {failed ? (
        <Text variant="caption" tone="tertiary">
          Couldn’t read a date from that — try “tomorrow 3pm” or use a preset.
        </Text>
      ) : null}

      <View style={styles.presets}>
        {presets.map((p) => (
          <PresetChip key={p.label} label={p.label} active={false} onPress={() => onSet(p.at().toISOString())} />
        ))}
      </View>
    </View>
  );
}

/** A quick-set preset under a metadata editor: a squared 22px chip (30px on touch); the
 *  fill steps on hover/press and the chosen repeat cadence takes the soft accent. */
function PresetChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const touch = useDensity() === "touch";
  return (
    <Pressable
      onPress={onPress}
      style={({ hovered, pressed }: PressState) => [
        styles.chip,
        touch ? styles.chipTouch : null,
        hovered ? styles.metaChipHover : null,
        pressed ? styles.metaChipPressed : null,
        active ? styles.chipActive : null,
      ]}
    >
      <Text variant="caption" tone={active ? "accent" : "secondary"}>
        {label}
      </Text>
    </Pressable>
  );
}

/** The reminders control (PLAN §6.4): the task's reminders as removable chips; one-tap leads
 *  counted back from the deadline ("Day before" … "Month before", toggled on and off); a field
 *  that reads either kind in core ("2 days before", "tomorrow 9am"); and exact-time presets
 *  plus a picker. Every change saves the whole list, which core normalizes. */
function RemindersRow({
  task,
  onChange,
  onAddDeadline,
}: {
  task: Task;
  onChange: (next: TaskReminder[]) => void;
  onAddDeadline: () => void;
}) {
  const { tasks: api } = useCore();
  const touch = useDensity() === "touch";
  const [nl, setNl] = useState("");
  const [failed, setFailed] = useState(false);
  // What the last typed phrase became, echoed back as mono `→ 2 days before`.
  const [echo, setEcho] = useState<string | null>(null);
  // An exact moment being picked; added on "Add" (the picker fires on every segment edit).
  const [exact, setExact] = useState<string | null>(null);
  const reminders = task.reminders ?? [];
  const full = reminders.length >= MAX_REMINDERS;

  const has = (r: TaskReminder) => reminders.some((x) => sameReminder(x, r));
  const add = (r: TaskReminder) => {
    if (!has(r) && !full) onChange([...reminders, r]);
  };
  const remove = (r: TaskReminder) => onChange(reminders.filter((x) => !sameReminder(x, r)));

  const submitNl = async () => {
    const text = nl.trim();
    if (!text) return;
    const { reminder } = await api.parseReminder(text);
    if (reminder) {
      add(reminder);
      setNl("");
      setFailed(false);
      setEcho(reminderLabel(reminder));
    } else {
      setFailed(true);
      setEcho(null);
    }
  };

  return (
    <View style={{ gap: space.sm }}>
      {reminders.length ? (
        <View style={styles.presets}>
          {reminders.map((r) => (
            <ReminderChip key={r.at ?? r.before} reminder={r} inert={!r.at && !task.dueAt} onRemove={() => remove(r)} />
          ))}
        </View>
      ) : null}

      <Input
        size="sm"
        placeholder="Type a reminder, e.g. 2 days before or tomorrow 9am"
        value={nl}
        onChangeText={(t) => {
          setNl(t);
          setFailed(false);
          if (t) setEcho(null);
        }}
        onSubmitEditing={() => void submitNl()}
        leadingIcon={<Icon name="bell" size={12} color={colors.textQuaternary} />}
      />
      {echo ? (
        <Text variant="mono" tone="quaternary">
          → {echo}
        </Text>
      ) : null}
      {failed ? (
        <Text variant="caption" tone="tertiary">
          Couldn’t read a reminder from that — try “3 days before” or “tomorrow 9am”.
        </Text>
      ) : null}

      <Text variant="caption" tone="tertiary">
        Before the deadline
      </Text>
      {task.dueAt ? (
        <View style={styles.presets}>
          {REMINDER_LEAD_PRESETS.map((p) => {
            const on = has({ before: p.before });
            return (
              <PresetChip
                key={p.before}
                label={p.label}
                active={on}
                onPress={() => (on ? remove({ before: p.before }) : add({ before: p.before }))}
              />
            );
          })}
        </View>
      ) : (
        <View style={styles.inputRow}>
          <Text variant="caption" tone="quaternary" style={{ flex: 1 }}>
            Set a deadline to be reminded a day, a week or a month before it.
          </Text>
          <Button label="Add deadline" variant="secondary" size="sm" onPress={onAddDeadline} />
        </View>
      )}

      <Text variant="caption" tone="tertiary">
        At a set time
      </Text>
      {/* The exact-time picker is web-only; native sets exact times by typing or presets. */}
      {Platform.OS === "web" ? (
        <View style={styles.inputRow}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <DateTimeInput value={exact} onSet={setExact} />
          </View>
          <Button
            label="Add"
            variant="secondary"
            size={touch ? undefined : "sm"}
            disabled={!exact || full}
            onPress={() => {
              if (!exact) return;
              add({ at: exact });
              setExact(null);
            }}
          />
        </View>
      ) : null}
      <View style={styles.presets}>
        {reminderPresets().map((p) => (
          <PresetChip key={p.label} label={p.label} active={false} onPress={() => add({ at: p.at().toISOString() })} />
        ))}
      </View>
      {full ? (
        <Text variant="caption" tone="tertiary">
          That’s the most reminders a task can have ({MAX_REMINDERS}).
        </Text>
      ) : null}
    </View>
  );
}

/** A set reminder in the reminders editor: its label with a remove (✕). A lead on a task with
 *  no deadline reads muted — it's kept, but won't fire until a deadline is set. */
function ReminderChip({ reminder, inert, onRemove }: { reminder: TaskReminder; inert: boolean; onRemove: () => void }) {
  const touch = useDensity() === "touch";
  return (
    <View style={[styles.chip, touch ? styles.chipTouch : null, styles.reminderChip, inert ? styles.reminderChipInert : null]}>
      <Icon name="bell" size={11} color={inert ? colors.textQuaternary : colors.textSecondary} />
      <Text variant="mono" tone={inert ? "quaternary" : "secondary"}>
        {reminderLabel(reminder)}
      </Text>
      <Pressable onPress={onRemove} aria-label="Remove reminder" hitSlop={touch ? 10 : 3} style={styles.metaChipClear}>
        <Icon name="close" size={11} color={colors.textQuaternary} />
      </Pressable>
    </View>
  );
}

/** The repeat control: preset cadences plus a live preview of the next few occurrences
 *  (computed in core from the chosen rule and the task's deadline — else its start — as
 *  anchor, PLAN §6.4).
 *  Choosing a repeat turns the task into a seed; the server materializes its occurrences. */
function RepeatRow({ task, onSet, onConnectSync }: { task: Task; onSet: (rule: string) => void; onConnectSync?: () => void }) {
  const { tasks: api } = useCore();
  const { connected } = useSync();
  const current = (task.repeatRule ?? "").trim().replace(/^RRULE:/i, "").toUpperCase();
  const [preview, setPreview] = useState<string[] | null>(null);
  const [nl, setNl] = useState("");
  const [failed, setFailed] = useState(false);

  // Refresh the preview whenever the rule or the anchor (due date) changes.
  useEffect(() => {
    let live = true;
    if (!current) {
      setPreview(null);
      return;
    }
    // The schedule's anchor: the deadline, else the start (core/domain.RepeatAnchor).
    void api.repeatPreview(task.repeatRule ?? "", task.dueAt ?? task.startAt ?? undefined, 3).then((res) => {
      if (live) setPreview(res.valid ? (res.occurrences ?? []) : null);
    });
    return () => {
      live = false;
    };
  }, [api, task.repeatRule, task.dueAt, task.startAt, current]);

  // Parse a typed cadence ("every monday", "the third wednesday of the month") in core.
  const submitNl = async () => {
    const text = nl.trim();
    if (!text) return;
    const { rule } = await api.parseRepeat(text);
    if (rule) {
      onSet(rule);
      setNl("");
      setFailed(false);
    } else {
      setFailed(true);
    }
  };

  return (
    <View style={{ gap: space.sm }}>
      {!connected ? (
        <View style={styles.repeatCta}>
          <Icon name="repeat" size={14} color={colors.textTertiary} />
          <View style={{ flex: 1, gap: space.xxs }}>
            <Text variant="label" tone="secondary">
              Repeats need a connected sync server
            </Text>
            <Text variant="caption" tone="tertiary">
              {current
                ? "This task won’t recur until you connect a server to generate its occurrences."
                : "Occurrences are generated on your sync server. Connect one to make tasks recur."}
            </Text>
          </View>
          {onConnectSync ? <Button label="Connect" variant="secondary" size="sm" onPress={onConnectSync} /> : null}
        </View>
      ) : null}
      <Input
        size="sm"
        placeholder="Type a cadence, e.g. every other tuesday"
        value={nl}
        onChangeText={(t) => {
          setNl(t);
          setFailed(false);
        }}
        onSubmitEditing={() => void submitNl()}
        leadingIcon={<Icon name="repeat" size={12} color={colors.textQuaternary} />}
      />
      {failed ? (
        <Text variant="caption" tone="tertiary">
          Couldn’t read a repeat from that — try “every monday” or pick one below.
        </Text>
      ) : null}
      <View style={styles.presets}>
        {REPEAT_PRESETS.map((p) => {
          const active = p.rule.toUpperCase() === current;
          return (
            <PresetChip key={p.label} label={p.label} active={active} onPress={() => onSet(p.rule)} />
          );
        })}
      </View>
      {current ? (
        preview && preview.length ? (
          <Text variant="mono" tone="quaternary">
            next → {preview.map((iso) => formatDueShort(iso)).join(" · ")}
          </Text>
        ) : (
          <Text variant="caption" tone="tertiary">
            Occurrences are created once this task syncs to your server.
          </Text>
        )
      ) : null}
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

function startPresets() {
  return [
    { label: "Today", at: () => atToday(9) },
    { label: "Tomorrow", at: () => atDaysFrom(1, 9) },
    { label: "In a week", at: () => atDaysFrom(7, 9) },
  ];
}
function deadlinePresets() {
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
  // 28px sub-toolbar with a bottom hairline; icon buttons are `sm` with 13px glyphs.
  subToolbar: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.xs,
    height: layout.subToolbarH,
    paddingLeft: space.ml,
    paddingRight: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    flexShrink: 0,
  },
  // Touch density: a 44px bar of `lg` buttons.
  subToolbarTouch: { height: row.touch, paddingLeft: space.xl, paddingRight: space.md },
  body: { flex: 1, flexDirection: "row" as const, minHeight: 0 },
  // Page gutters: 20px top / 28px sides with a pointer; a tight inset on a phone.
  page: { paddingTop: space.xl2, paddingHorizontal: 28, paddingBottom: space.huge },
  pageTouch: { paddingVertical: space.lg, paddingHorizontal: space.xl },
  // The document column, centered in the page.
  doc: { maxWidth: 560, width: "100%" as const, alignSelf: "center" as const, gap: space.sm },
  titleRow: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: space.md },
  // The document title (DocTitleField): the 30px display size with a pointer, 20px on touch
  // (30px clips on a phone). Line heights are fixed so wrapped lines and the checkbox align.
  title: {
    padding: 0,
    color: colors.textPrimary,
    fontFamily: font.sans,
    fontWeight: font.weight.semibold,
    textAlignVertical: "top" as const,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none", overflow: "hidden" } as Record<string, unknown>) : null),
  },
  titlePointer: { fontSize: font.size.display, lineHeight: TITLE_LINE.pointer, letterSpacing: font.tracking.tight },
  titleTouch: { fontSize: font.size["2xl"], lineHeight: TITLE_LINE.touch, letterSpacing: font.tracking.snug },
  // Chips + their expanded editors sit indented under the title (past the checkbox; the
  // indent itself is computed from the checkbox size).
  metaRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: space.sm, marginTop: space.xs, zIndex: 1 },
  metaEditor: { marginTop: space.xs, marginBottom: space.xs },
  // With a pointer the editors and the notes field stop at a comfortable 420px.
  narrow: { maxWidth: 420 },
  archetype: { marginTop: space.md },
  // The notes editor as a bordered field, left-aligned with the metadata column above it.
  notesField: {
    marginTop: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceApp,
  },
  metaChip: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.xs,
    height: control.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: "transparent" as const,
  },
  metaChipTouch: { height: control.lg, paddingHorizontal: space.ml },
  metaChipFilled: { backgroundColor: colors.surfaceSunken },
  metaChipHover: { backgroundColor: colors.surfaceHover },
  metaChipPressed: { backgroundColor: colors.surfaceActive },
  metaChipActive: { backgroundColor: colors.accentSoft, borderColor: colors.accentSoftBorder },
  metaChipClear: { marginLeft: 1, padding: 3, marginVertical: -3, marginRight: -3 },
  inputRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm },
  presets: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: space.xs },
  chip: {
    height: control.sm,
    justifyContent: "center" as const,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderDefault,
  },
  chipTouch: { height: control.lg, paddingHorizontal: space.ml },
  chipActive: { backgroundColor: colors.accentSoft, borderColor: colors.accentSoftBorder },
  // A set reminder: the preset chip's shape, laid out like a metadata chip (icon, value, ✕).
  reminderChip: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.xs, backgroundColor: colors.surfaceSunken },
  reminderChipInert: { borderStyle: "dashed" as const, backgroundColor: "transparent" as const },
  repeatCta: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surfaceSunken,
  },
  check: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    flexShrink: 0,
  },
  checkOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  // 24px dense row (44px on touch): radius 3, padding 0 6, gap 6.
  taskRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.sm,
    minHeight: row.h,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
  },
  taskRowTouch: { minHeight: row.touch, gap: space.ml },
  taskTitle: { flex: 1, minWidth: 0 },
  doneTitle: { textDecorationLine: "line-through" as const },
};
