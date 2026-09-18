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
  font,
  layout,
  motion,
  radius,
  space,
  transition,
  useDensity,
  type PressState,
} from "@companion/design-system";
import type { CalendarItem } from "@companion/core-bridge";
import { Editor, type EditorController, type FormatState, type LinkRef } from "@companion/editor";
import { Agenda, itemDay } from "./CalendarAgenda";
import { FormattingBar } from "./FormattingBar";
import { tableMenuPresenter } from "./tableMenu";
import { useNav } from "./nav-context";
import { useNotes } from "./NotesProvider";
import { useSync } from "./SyncProvider";
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
  // The tab may have been opened on a specific day (a dated note followed from the
  // calendar, or a /today/<date> link); it seeds the selection and re-selects if it changes.
  const requestedDay = nav.current.kind === "view" ? nav.current.date : undefined;
  const [selected, setSelected] = useState(() => requestedDay ?? todayISO());
  useEffect(() => {
    if (requestedDay) setSelected(requestedDay);
  }, [requestedDay]);
  // The wall clock can roll past midnight while the screen is mounted; recompute "today" so
  // future-day gating and the "today" markers stay honest without a manual refresh.
  const [today, setToday] = useState(todayISO);
  // Only the visible tab keeps the clock; a background tab catches up the moment it's shown.
  useEffect(() => {
    if (!nav.visible) return;
    setToday(todayISO());
    const id = setInterval(() => setToday(todayISO()), 60_000);
    return () => clearInterval(id);
  }, [nav.visible]);

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
          visible={nav.visible}
          onSelect={setSelected}
          onOpenItem={(item) => {
            // A dated note is a daily note: select its day here instead of opening a tab.
            if (item.kind === "task") nav.openInNewTab({ kind: "task", id: item.sourceId });
            else if (item.kind === "note") setSelected(itemDay(item));
          }}
        />
      }
    >
      <View style={styles.content}>
        <View style={styles.subToolbar}>
          <Text variant="mono" tone="tertiary" style={styles.crumb} numberOfLines={1}>
            Daily notes / {formatFullDate(selected)}
          </Text>
          {isToday ? <Badge tone="accent" label="today" /> : null}
          {!isToday ? (
            <Button variant="ghost" size="sm" label="Jump to today" onPress={() => setSelected(today)} />
          ) : null}
        </View>
        {/* Keyed by date so switching days remounts with that day's content seeded in.
            DailyNote owns its own scroll region on web so the pinned formatting bar stays
            under the fixed viewport rather than scrolling away with the document. */}
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
  const touch = useDensity() === "touch";
  const linkSource = useLinkSource();
  // File embedding (PLAN §6.9): present on web (OPFS blob store), undefined elsewhere.
  const documentSource = useDocumentSource();

  // Resolve this day's note once, at mount. `notes.notes` is newest-updated first, so `find`
  // lands on the most recent note for the day if somehow more than one shares the date. We
  // deliberately don't re-derive after mount: the editor owns its content once seeded.
  const initial = useRef(notes.notes.find((n) => n.date === date)).current;
  const noteIdRef = useRef<string | null>(initial?.id ?? null);
  const [hasNote, setHasNote] = useState(!!initial);

  // Web/desktop: the formatting bar sits pinned under the document. The editor
  // reports which toggles are active/available; the ref drives them. (Native renders its own
  // keyboard-anchored toolbar inside the editor, so this stays dormant there.) Mirrors the
  // note editor's formatting-bar plumbing.
  const editorRef = useRef<EditorController>(null);
  // Empty `[[label]]` links double-click to a quick-create dialog (make a note/task chip).
  const quickCreate = useQuickCreateLink(editorRef);
  const [formatState, setFormatState] = useState<FormatState | null>(null);
  // Touch web shows the bar only while the editor is focused. Clicking a bar button briefly
  // blurs the editor (the action then refocuses it), so hiding is delayed a beat to avoid a flicker.
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
        <Text variant="title" style={touch ? styles.headingTouch : null}>
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
  // the host View is enough. Web/desktop: own the scroll region here so the pinned formatting
  // bar stays under this fixed container instead of scrolling away with the document.
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
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.docScroll}>
        <View style={styles.doc}>{body}</View>
      </ScrollView>
      {/* The bar is pinned under the document as the column's last row. A pointer keeps it
          up permanently; touch web only shows it while the editor has focus. */}
      {!touch || editorFocused ? (
        <FormattingBar state={formatState} editorRef={editorRef} canAttach={!!documentSource} />
      ) : null}
      {quickCreate.dialog}
    </View>
  );
}

/** Desktop aside wrapper: the mini calendar, the selected day's agenda and the sync state in
 *  a scrollable side panel. The SplitView draws the hairline; this pane is flat. */
function CalendarPane(props: {
  selected: string;
  today: string;
  /** False while this tab sits in the background — pauses the sync section's clock. */
  visible: boolean;
  onSelect: (date: string) => void;
  onOpenItem?: (item: CalendarItem) => void;
}) {
  return (
    <ScrollView style={styles.aside} contentContainerStyle={styles.asideContent}>
      <TodayCalendar selected={props.selected} today={props.today} onSelect={props.onSelect} />
      <Agenda date={props.selected} onOpenItem={props.onOpenItem} />
      <SyncSection visible={props.visible} />
    </ScrollView>
  );
}

/** '12s' / '4m' / '3h' / '2d' since `at` — mono metadata, so terse and lowercase. */
function agoLabel(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/** The aside's sync line: a 5px state dot and what the machine knows, in mono. Mirrors the
 *  shell status bar's states so the two never disagree. */
function SyncSection({ visible }: { visible: boolean }) {
  const sync = useSync();
  // Re-render on a slow tick so "12s ago" stays honest without a sync event.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!visible) return;
    const t = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, [visible]);

  const state = !sync.connected
    ? { color: colors.textQuaternary, label: "local only" }
    : sync.status === "syncing"
      ? { color: colors.accent, label: "syncing…" }
      : sync.status === "locked"
        ? { color: colors.danger, label: "locked" }
        : sync.status === "error" || sync.needsReauth
          ? { color: colors.danger, label: sync.needsReauth ? "signed out" : "sync error" }
          : { color: colors.success, label: sync.lastSyncedAt ? `synced · ${agoLabel(sync.lastSyncedAt)} ago` : "connected" };

  return (
    <View>
      <Text variant="eyebrow" tone="quaternary" style={styles.sectionLabel}>
        Sync
      </Text>
      <View style={styles.syncRow}>
        <View style={[styles.syncDot, { backgroundColor: state.color }]} />
        <Text variant="mono" tone="tertiary" numberOfLines={1}>
          {state.label}
        </Text>
      </View>
    </View>
  );
}

/** A mini month calendar. Days with a note show a 3px dot; today is the filled accent cell;
 *  the selected day takes the selected fill. Past days and today are always clickable; future
 *  days are disabled in the daily-note picker (you don't write tomorrow's note) but selectable
 *  when `allowFuture` is set — the Calendar tool browses upcoming events. Layout-neutral so
 *  either shell can place it; cells are 22px under a pointer and 30px under touch. */
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
  const touch = useDensity() === "touch";
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
  const cellHeight = touch ? CELL_H_TOUCH : CELL_H;

  return (
    <View>
      <View style={styles.calHeader}>
        <Text variant="label" style={{ flex: 1 }} numberOfLines={1}>
          {MONTHS[view.month]} {view.year}
        </Text>
        {/* Touch leaves the size to the density default (lg); the pointer aside is sm. */}
        <IconButton label="Previous month" size={touch ? undefined : "sm"} onPress={() => step(-1)}>
          <Icon name="chevronLeft" size={touch ? 14 : 12} color={colors.textSecondary} />
        </IconButton>
        <IconButton label="Next month" size={touch ? undefined : "sm"} onPress={() => step(1)}>
          <Icon name="chevronRight" size={touch ? 14 : 12} color={colors.textSecondary} />
        </IconButton>
      </View>

      <View style={styles.grid}>
        {DOW.map((d, i) => (
          <View key={`dow-${i}`} style={styles.dowCell}>
            <Text variant="mono" tone="quaternary">
              {d}
            </Text>
          </View>
        ))}
      </View>

      <View style={styles.grid}>
        {cells.map((d, i) => {
          if (d === null) return <View key={`x-${i}`} style={[styles.cell, { height: cellHeight + 2 }]} />;
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
              height={cellHeight}
              touch={touch}
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
  height,
  touch,
  selected,
  today,
  disabled,
  hasNote,
  onPress,
}: {
  day: number;
  label: string;
  height: number;
  touch: boolean;
  selected: boolean;
  today: boolean;
  disabled: boolean;
  hasNote: boolean;
  onPress: () => void;
}) {
  // Today is the one filled cell; a selected day that isn't today reads like any other
  // selection (selected fill + accent ink). Future days read muted only when they're also
  // disabled (the daily-note picker); when the Calendar tool lets you browse ahead, upcoming
  // days render as normal selectable days.
  const fg = today
    ? colors.onAccent
    : selected
      ? colors.textAccent
      : disabled
        ? colors.textDisabled
        : colors.textSecondary;
  return (
    <View style={styles.cell}>
      <Pressable
        disabled={disabled}
        onPress={onPress}
        aria-label={label}
        // react-native-web supplies `hovered`; it's always false on native (no hover), which
        // is the correct fallback.
        style={({ hovered, pressed }: PressState) => [
          styles.day,
          transition("background-color", motion.instant),
          {
            height,
            backgroundColor: today
              ? pressed
                ? colors.accentActive
                : hovered
                  ? colors.accentHover
                  : colors.accent
              : selected
                ? colors.surfaceSelected
                : pressed && !disabled
                  ? colors.surfaceActive
                  : hovered && !disabled
                    ? colors.surfaceHover
                    : "transparent",
          },
          selected && !today ? styles.daySelected : null,
        ]}
      >
        <Text
          variant="mono"
          style={{ color: fg, fontSize: touch ? font.size.sm : font.size.xs, fontWeight: today || selected ? font.weight.semibold : font.weight.regular }}
        >
          {day}
        </Text>
        {hasNote ? <View style={[styles.noteDot, { backgroundColor: today ? colors.onAccent : colors.accent }]} /> : null}
      </Pressable>
    </View>
  );
}

// Mini-calendar day cells: 22px under a pointer, 30px under touch.
const CELL_H = 22;
const CELL_H_TOUCH = 30;

const styles = {
  content: { flex: 1, minWidth: 0, backgroundColor: colors.surfaceCard },
  subToolbar: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.sm,
    height: layout.subToolbarH,
    paddingLeft: space.ml,
    paddingRight: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    flexShrink: 0,
  },
  crumb: { flex: 1, minWidth: 0 },
  // The document column: 20/28 page padding around a 720px measure, left-aligned like the
  // note editor so the two read as the same page.
  docScroll: { paddingHorizontal: 28, paddingTop: space.xl2, paddingBottom: space.huge },
  doc: { maxWidth: layout.contentMax, width: "100%" as const },
  page: { flex: 1 },
  // Touch drops the desktop title for the phone's 20px semibold heading.
  headingTouch: { fontSize: font.size["2xl"], lineHeight: 24, letterSpacing: -0.5 },
  meta: { marginTop: space.xs, marginBottom: space.xl },

  aside: { flex: 1, backgroundColor: colors.surfaceCard },
  asideContent: { padding: space.ml },
  sectionLabel: { paddingHorizontal: space.sm, paddingTop: space.md, paddingBottom: 3 },
  syncRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.sm,
    paddingHorizontal: space.sm,
    minHeight: 18,
  },
  syncDot: { width: 5, height: 5, flexShrink: 0, borderRadius: radius.full },

  calHeader: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.xs,
    paddingTop: space.xxs,
    paddingBottom: space.sm,
    paddingHorizontal: space.sm,
  },
  // A 7-column grid with a 2px gutter: each cell carries 1px of padding, the grid 3px, so
  // the numerals sit 4px in from the pane's own padding.
  grid: { flexDirection: "row" as const, flexWrap: "wrap" as const, paddingHorizontal: 3 },
  cell: { width: `${100 / 7}%` as const, padding: 1 },
  dowCell: { width: `${100 / 7}%` as const, alignItems: "center" as const, paddingBottom: space.xxs },
  day: {
    borderRadius: radius.sm,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  daySelected: { borderWidth: 1, borderColor: colors.accentSoftBorder },
  noteDot: { width: 3, height: 3, marginTop: 1, borderRadius: radius.full },
};
