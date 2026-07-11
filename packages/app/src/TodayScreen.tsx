import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import {
  Badge,
  Button,
  Icon,
  IconButton,
  SplitView,
  Text,
  colors,
  layout,
  radius,
  space,
  type PressState,
} from "@companion/design-system";
import type { CalendarItem } from "@companion/core-bridge";
import { Editor, type EditorController, type FormatState, type LinkRef } from "@companion/editor";
import { Agenda } from "./CalendarAgenda";
import { FormattingBar } from "./FormattingBar";
import { tableMenuPresenter } from "./tableMenu";
import { useNav } from "./nav-context";
import { useNotes } from "./NotesProvider";
import { useTasks } from "./TasksProvider";
import { useLinkSource } from "./useLinkSource";
import { useQuickCreateLink } from "./useQuickCreateLink";
import { useDocumentSource } from "./DocumentSourceContext";

// The "Today" tool (PLAN §6.x): a large daily-note editor with a small mini-calendar aside.
// A daily note is an ordinary note stamped with a `date` (YYYY-MM-DD). The note for the
// selected day is looked up by that date; it isn't written to the database until the user
// actually types — until then the view is a live placeholder for that day.

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DOW = ["S", "M", "T", "W", "T", "F", "S"];

/** Local calendar date as 'YYYY-MM-DD' (the note.date format), in the user's timezone. */
function toISODate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function todayISO(): string {
  return toISODate(new Date());
}
/** '2026-07-08' → 'July 8, 2026'. Parsed as local (not UTC) to avoid an off-by-one. */
export function formatFullDate(iso: string): string {
  const [y, m, day] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${day}, ${y}`;
}

export function TodayScreen() {
  const nav = useNav();
  const [selected, setSelected] = useState(todayISO);
  // The wall clock can roll past midnight while the screen is mounted; recompute "today" so
  // future-day gating and the "today" markers stay honest without a manual refresh.
  const [today, setToday] = useState(todayISO);
  useEffect(() => {
    const id = setInterval(() => setToday(todayISO()), 60_000);
    return () => clearInterval(id);
  }, []);

  const isToday = selected === today;

  return (
    <SplitView
      storageKey="companion.today.calendarWidth"
      asideSide="right"
      defaultWidth={320}
      minWidth={260}
      maxWidth={420}
      aside={
        <CalendarPane
          selected={selected}
          today={today}
          onSelect={setSelected}
          onOpenItem={(item) => {
            if (item.kind === "task" || item.kind === "note") nav.openInNewTab({ kind: item.kind, id: item.sourceId });
          }}
        />
      }
    >
      <View style={styles.content}>
        <View style={styles.subToolbar}>
          <Text variant="mono" tone="tertiary" style={{ flex: 1 }} numberOfLines={1}>
            Daily notes / {formatFullDate(selected)}
          </Text>
          {isToday ? <Badge tone="accent" label="today" /> : null}
          {!isToday ? (
            <Button variant="ghost" size="sm" label="Jump to today" onPress={() => setSelected(today)} />
          ) : null}
        </View>
        {/* Keyed by date so switching days remounts with that day's content seeded in.
            DailyNote owns its own scroll region on web so the floating formatting bar can
            anchor to the fixed viewport rather than scroll away with the document. */}
        <DailyNote
          key={selected}
          date={selected}
          onOpenRef={(ref) => {
            // Clicking a chip opens its target in a new workspace tab.
            if (ref.type === "task" || ref.type === "note") nav.openInNewTab({ kind: ref.type, id: ref.id });
          }}
        />
      </View>
    </SplitView>
  );
}

/** The large daily-note editor for one day. If no note exists for `date` yet, the editor is
 *  a live placeholder: it creates the note (stamped with `date`) on the first keystroke and
 *  routes edits to it thereafter — nothing is written until the user types. `onOpenRef` is
 *  wired by the host shell (a new workspace tab on desktop, a pushed screen on mobile). */
export function DailyNote(props: {
  date: string;
  onOpenRef?: (ref: LinkRef) => void;
  /** Horizontal inset for the date heading, to align it with the editor body. Desktop nests
   *  this in a padded page already (0); mobile passes the editor's 20px body inset. */
  headingPadding?: number;
}) {
  const notes = useNotes();
  // `DailyNoteBody` resolves the day's existing note once, at mount, and deliberately never
  // re-derives (the editor owns its content once seeded). So it must not mount until the note
  // list has loaded — otherwise it seeds from an empty list, shows a blank editor for a day
  // that already has a note, and the first keystroke creates a *duplicate* note instead of
  // editing the existing one. Wait for the list; the body then mounts fresh with the real seed.
  if (notes.loading) return <View style={styles.page} />;
  return <DailyNoteBody {...props} />;
}

function DailyNoteBody({
  date,
  onOpenRef,
  headingPadding = 0,
}: {
  date: string;
  onOpenRef?: (ref: LinkRef) => void;
  headingPadding?: number;
}) {
  const notes = useNotes();
  const tasks = useTasks();
  const linkSource = useLinkSource();
  // File embedding (PLAN §6.9): present on web (OPFS blob store), undefined elsewhere.
  const documentSource = useDocumentSource();

  // Resolve this day's note once, at mount. `notes.notes` is newest-updated first, so `find`
  // lands on the most recent note for the day if somehow more than one shares the date. We
  // deliberately don't re-derive after mount: the editor owns its content once seeded.
  const initial = useRef(notes.notes.find((n) => n.date === date)).current;
  const noteIdRef = useRef<string | null>(initial?.id ?? null);
  const [hasNote, setHasNote] = useState(!!initial);

  // Web/desktop: the formatting bar floats over the editor while it's focused. The editor
  // reports which toggles are active/available; the ref drives them. (Native renders its own
  // keyboard-anchored toolbar inside the editor, so this stays dormant there.) Mirrors the
  // note editor's formatting-bar plumbing.
  const editorRef = useRef<EditorController>(null);
  // Empty `[[label]]` links double-click to a quick-create dialog (make a note/task chip).
  const quickCreate = useQuickCreateLink(editorRef);
  const [formatState, setFormatState] = useState<FormatState | null>(null);
  // Show the bar whenever the editor is focused. Clicking a bar button briefly blurs the
  // editor (the action then refocuses it), so hiding is delayed a beat to avoid a flicker.
  const [editorFocused, setEditorFocused] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleFocusChange = useCallback((focused: boolean) => {
    if (blurTimer.current) {
      clearTimeout(blurTimer.current);
      blurTimer.current = null;
    }
    if (focused) setEditorFocused(true);
    else blurTimer.current = setTimeout(() => setEditorFocused(false), 200);
  }, []);
  useEffect(
    () => () => {
      if (blurTimer.current) clearTimeout(blurTimer.current);
    },
    [],
  );

  // Create-on-first-keystroke, guarded so a burst of edits before the create resolves can't
  // spawn duplicate notes; the latest content typed during creation is flushed afterwards.
  const creating = useRef(false);
  const latest = useRef<string | null>(null);

  const handleChange = (md: string) => {
    const id = noteIdRef.current;
    if (id) {
      notes.save(id, { contentMd: md });
      return;
    }
    latest.current = md;
    if (creating.current) return;
    creating.current = true;
    void notes
      .create({ title: formatFullDate(date), contentMd: md, date })
      .then((n) => {
        noteIdRef.current = n.id;
        setHasNote(true);
        if (latest.current != null && latest.current !== md) {
          notes.save(n.id, { contentMd: latest.current });
        }
      })
      .finally(() => {
        creating.current = false;
      });
  };

  const body = (
    <>
      <View style={{ paddingHorizontal: headingPadding }}>
        <Text variant="title" style={styles.heading}>
          {formatFullDate(date)}
        </Text>
        <Text variant="mono" tone="tertiary" style={styles.meta}>
          {hasNote ? `Daily note · ${date}` : "no note yet"}
        </Text>
      </View>
      <Editor
        ref={editorRef}
        markdown={initial?.contentMd ?? ""}
        onChangeMarkdown={handleChange}
        linkSource={linkSource}
        documentSource={documentSource}
        // A fresh identity whenever any task changes re-hydrates `[[task:…]]` chips.
        linkRevision={tasks.tasks}
        placeholder="Start today’s note…"
        onOpenRef={onOpenRef}
        onQuickCreate={quickCreate.onQuickCreate}
        onFormatStateChange={setFormatState}
        onFocusChange={handleFocusChange}
        // Desktop injects a Wails-backed native table menu; web uses the built-in HTML popup.
        tableMenuPresenter={tableMenuPresenter()}
      />
    </>
  );

  // Native: the editor manages its own keyboard-anchored toolbar and scrolls internally, so
  // the host View is enough. Web/desktop: own the scroll region here so the floating
  // formatting bar can anchor to this fixed container instead of scrolling with the document.
  if (Platform.OS !== "web") {
    return (
      <View style={styles.page}>
        {body}
        {quickCreate.dialog}
      </View>
    );
  }

  return (
    <View style={styles.page}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.doc}>
        {body}
      </ScrollView>
      {editorFocused ? (
        <FormattingBar state={formatState} editorRef={editorRef} canAttach={!!documentSource} />
      ) : null}
      {quickCreate.dialog}
    </View>
  );
}

/** Desktop aside wrapper: the mini calendar plus the selected day's agenda in a scrollable,
 *  bordered side panel. */
function CalendarPane(props: {
  selected: string;
  today: string;
  onSelect: (date: string) => void;
  onOpenItem?: (item: CalendarItem) => void;
}) {
  return (
    <ScrollView style={styles.aside} contentContainerStyle={{ padding: space.xl }}>
      <TodayCalendar selected={props.selected} today={props.today} onSelect={props.onSelect} />
      <View style={styles.agendaBlock}>
        <Agenda date={props.selected} onOpenItem={props.onOpenItem} />
      </View>
    </ScrollView>
  );
}

/** A mini month calendar. Days with a note show a dot; today is outlined; the selected day
 *  is filled. Past days and today are always clickable; future days are disabled in the
 *  daily-note picker (you don't write tomorrow's note) but selectable when `allowFuture` is
 *  set — the Calendar tool browses upcoming events. Layout-neutral so either shell can place it. */
export function TodayCalendar({
  selected,
  today,
  onSelect,
  allowFuture = false,
}: {
  selected: string;
  today: string;
  onSelect: (date: string) => void;
  allowFuture?: boolean;
}) {
  const notes = useNotes();
  const daysWithNotes = useMemo(() => {
    const set = new Set<string>();
    for (const n of notes.notes) if (n.date) set.add(n.date);
    return set;
  }, [notes.notes]);

  // The visible month, seeded from the selected day. Snap to follow the selection when it
  // jumps to another month (e.g. "Jump to today").
  const [view, setView] = useState(() => {
    const [y, m] = selected.split("-").map(Number);
    return { year: y, month: m - 1 };
  });
  useEffect(() => {
    const [y, m] = selected.split("-").map(Number);
    if (y !== view.year || m - 1 !== view.month) setView({ year: y, month: m - 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const first = new Date(view.year, view.month, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(view.year, view.month + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < first; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const p = (n: number) => String(n).padStart(2, "0");
  const iso = (d: number) => `${view.year}-${p(view.month + 1)}-${p(d)}`;
  const step = (delta: number) => {
    const m = view.month + delta;
    setView({ year: view.year + Math.floor(m / 12), month: ((m % 12) + 12) % 12 });
  };

  return (
    <View>
      <View style={styles.calHeader}>
        <Text style={{ flex: 1, fontWeight: "600" }}>
          {MONTHS[view.month]} {view.year}
        </Text>
        <IconButton label="Previous month" size="sm" onPress={() => step(-1)}>
          <Icon name="chevronLeft" size={16} color={colors.textSecondary} />
        </IconButton>
        <IconButton label="Next month" size="sm" onPress={() => step(1)}>
          <Icon name="chevronRight" size={16} color={colors.textSecondary} />
        </IconButton>
      </View>

      <View style={styles.grid}>
        {DOW.map((d, i) => (
          <View key={`dow-${i}`} style={styles.dowCell}>
            <Text variant="mono" tone="tertiary" style={{ fontSize: 11 }}>
              {d}
            </Text>
          </View>
        ))}
      </View>

      <View style={styles.grid}>
        {cells.map((d, i) => {
          if (d === null) return <View key={`x-${i}`} style={styles.cell} />;
          const date = iso(d);
          const isSel = date === selected;
          const isToday = date === today;
          const isFuture = date > today;
          const hasNote = daysWithNotes.has(date);
          return (
            <DayCell
              key={date}
              day={d}
              label={formatFullDate(date)}
              selected={isSel}
              today={isToday}
              disabled={isFuture && !allowFuture}
              hasNote={hasNote}
              onPress={() => onSelect(date)}
            />
          );
        })}
      </View>
    </View>
  );
}

function DayCell({
  day,
  label,
  selected,
  today,
  disabled,
  hasNote,
  onPress,
}: {
  day: number;
  label: string;
  selected: boolean;
  today: boolean;
  disabled: boolean;
  hasNote: boolean;
  onPress: () => void;
}) {
  // Future days read muted only when they're also disabled (the daily-note picker); when the
  // Calendar tool lets you browse ahead, upcoming days render as normal selectable days.
  const fg = selected ? colors.onAccent : disabled ? colors.textTertiary : colors.textPrimary;
  return (
    <View style={styles.cell}>
      <Pressable
        disabled={disabled}
        onPress={onPress}
        aria-label={label}
        // react-native-web supplies `hovered`; it's always false on native (no hover), which
        // is the correct fallback.
        style={({ hovered }: PressState) => [
          styles.day,
          {
            backgroundColor: selected ? colors.accent : hovered && !disabled ? colors.surfaceHover : "transparent",
          },
          !selected && today ? styles.dayToday : null,
        ]}
      >
        <Text style={{ color: fg, fontWeight: today ? "600" : "400" }}>{day}</Text>
        {hasNote ? (
          <View style={[styles.noteDot, { backgroundColor: selected ? colors.onAccent : colors.accent }]} />
        ) : null}
      </Pressable>
    </View>
  );
}

const styles = {
  content: { flex: 1, minWidth: 0, backgroundColor: colors.surfaceCard },
  subToolbar: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.sm,
    height: 44,
    paddingHorizontal: space.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    flexShrink: 0,
  },
  doc: {
    maxWidth: layout.contentMax,
    width: "100%" as const,
    marginHorizontal: "auto" as const,
    paddingHorizontal: 44,
    paddingTop: 40,
    paddingBottom: 60,
  },
  page: { flex: 1 },
  heading: { fontSize: 30, lineHeight: 36, fontWeight: "600" as const, letterSpacing: -0.5 },
  meta: { marginTop: space.sm, marginBottom: space.xxl },

  aside: { flex: 1, backgroundColor: colors.surfaceCard, borderLeftWidth: 1, borderLeftColor: colors.borderSubtle },
  agendaBlock: { marginTop: space.xxl, paddingTop: space.xl, borderTopWidth: 1, borderTopColor: colors.borderSubtle },
  calHeader: { flexDirection: "row" as const, alignItems: "center" as const, marginBottom: space.lg },
  grid: { flexDirection: "row" as const, flexWrap: "wrap" as const },
  cell: { width: `${100 / 7}%` as const, aspectRatio: 1, padding: 2 },
  // The weekday header row is a slim label strip, not square day cells — squares left a big
  // gap under the S/M/T… labels.
  dowCell: { width: `${100 / 7}%` as const, alignItems: "center" as const, paddingBottom: space.xs },
  day: {
    flex: 1,
    borderRadius: radius.md,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    position: "relative" as const,
  },
  dayToday: { borderWidth: 1, borderColor: colors.accentSoftBorder },
  noteDot: {
    position: "absolute" as const,
    bottom: 5,
    width: 4,
    height: 4,
    marginTop: 2,
    borderRadius: radius.full,
  },
};
