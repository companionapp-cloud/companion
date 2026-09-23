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
import { Editor, type EditorController, type FormatState, type InkState, type LinkRef } from "@companion/editor";
import { Agenda, itemDay } from "./CalendarAgenda";
import { FormattingBar } from "./FormattingBar";
import { DrawingBar, useDrawingTool } from "./DrawingBar";
import { useNoteInk } from "./useNoteInk";
import { tableMenuPresenter } from "./tableMenu";
import { useNav } from "./nav-context";
import { useNotes } from "./NotesProvider";
import { useTasks } from "./TasksProvider";
import { useLinkSource } from "./useLinkSource";
import { useEditorDrop, useEditorRefDrag } from "./DndContext";
import { useQuickCreateLink } from "./useQuickCreateLink";
import { useDocumentSource } from "./DocumentSourceContext";
import { TourAnchor } from "./onboarding/anchors";
import { useAiStatus } from "./ai/useAiStatus";
import { useNoteAssist } from "./ai/useNoteAssist";
import { NoteAiDock } from "./ai/NoteAiPanel";

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
  // Drawing on the day's note (PLAN-drawing.md); kept here so it survives switching days.
  const [drawing, setDrawing] = useState(false);

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
            // Agenda items open in a new tab, so the day's note stays where it is — except a
            // dated note, which is a daily note: its day is selected here instead.
            if (item.kind === "task") nav.openInNewTab({ kind: "task", id: item.sourceId });
            else if (item.kind === "project") nav.openInNewTab({ kind: "project", projectId: item.sourceId });
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
          <View style={{ flex: 1 }} />
          <IconButton label={drawing ? "Stop drawing" : "Draw on note"} size="sm" active={drawing} onPress={() => setDrawing((d) => !d)}>
            <Icon name="pen" size={13} color={drawing ? colors.textAccent : colors.textSecondary} />
          </IconButton>
        </View>
        {/* Keyed by date so switching days remounts with that day's content seeded in.
            DailyNote owns its own scroll region on web so the pinned formatting bar stays
            under the fixed viewport rather than scrolling away with the document. */}
        <DailyNote
          key={selected}
          date={selected}
          drawing={drawing}
          onDrawingChange={setDrawing}
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
  /** Native: horizontal inset for the date heading, to line it up with the editor, which brings
   *  its own body inset there (20px on a phone). The web pads the whole page instead, heading
   *  and editor alike, so this is ignored there. */
  headingPadding?: number;
  /** Drawing mode (PLAN-drawing.md). The host owns the toggle; the drawing bar shows here. */
  drawing?: boolean;
  onDrawingChange?: (drawing: boolean) => void;
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
  drawing = false,
  onDrawingChange,
}: {
  date: string;
  onOpenRef?: (ref: LinkRef) => void;
  headingPadding?: number;
  drawing?: boolean;
  onDrawingChange?: (drawing: boolean) => void;
}) {
  const notes = useNotes();
  const tasks = useTasks();
  const touch = useDensity() === "touch";
  const linkSource = useLinkSource();
  // A link chip dragged out of the document (web/desktop): onto a project or area, a task onto
  // the Today agenda. Named, so the note doesn't take its own chip back as a drop.
  const dropId = `daily-note:${date}`;
  const refDrag = useEditorRefDrag(dropId);
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
  // What's dragged onto the page (an agenda item, a list row, a chip from elsewhere) lands as a
  // chip where it's released: a first write like any keystroke, so it creates the day's note.
  // The note itself doesn't go in the note.
  const dropRef = useEditorDrop(dropId, editorRef, (p) => !(p.kind === "note" && p.id === noteIdRef.current));
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

  // Create-on-first-write (a keystroke, or a stroke of ink), guarded so a burst of edits before
  // the create resolves can't spawn duplicate notes; the latest content typed during creation
  // is flushed afterwards.
  const creation = useRef<Promise<string | null> | null>(null);
  const latest = useRef<string | null>(null);
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const ensureNote = useCallback(
    (md: string): Promise<string | null> => {
      if (noteIdRef.current) return Promise.resolve(noteIdRef.current);
      if (!creation.current) {
        creation.current = notesRef.current
          .create({ title: formatFullDate(date), contentMd: md, date })
          .then((n) => {
            noteIdRef.current = n.id;
            setHasNote(true);
            if (latest.current != null && latest.current !== md) {
              notesRef.current.save(n.id, { contentMd: latest.current });
            }
            return n.id;
          })
          .catch(() => null)
          .finally(() => {
            creation.current = null;
          });
      }
      return creation.current;
    },
    [date],
  );

  const handleChange = (md: string) => {
    const id = noteIdRef.current;
    if (id) {
      notes.save(id, { contentMd: md });
      return;
    }
    latest.current = md;
    void ensureNote(md);
  };

  // Drawing on the day's note (PLAN-drawing.md). A first stroke on a day with no note yet
  // creates the note, just like a first keystroke.
  const ink = useNoteInk(
    hasNote ? noteIdRef.current : null,
    useCallback(() => ensureNote(latest.current ?? ""), [ensureNote]),
  );
  const [tool, setTool] = useDrawingTool();
  const [inkState, setInkState] = useState<InkState | null>(null);
  const exitDrawing = () => onDrawingChange?.(false);

  // Writing assists, as in the note editor. The day's note may not exist yet: applying a
  // result is a first write like any keystroke, so it creates the note.
  const aiOn = !!useAiStatus()?.enabled;
  const note = hasNote ? notes.notes.find((n) => n.id === noteIdRef.current) ?? null : null;
  const assist = useNoteAssist({ editorRef, note, title: formatFullDate(date) });
  const closeAssist = assist.close;
  useEffect(() => {
    if (!aiOn || drawing) closeAssist();
  }, [aiOn, drawing, closeAssist]);
  const drawingBar = drawing ? (
    <DrawingBar
      tool={tool}
      onChange={setTool}
      state={inkState}
      onUndo={() => editorRef.current?.inkUndo()}
      onRedo={() => editorRef.current?.inkRedo()}
      onDone={exitDrawing}
    />
  ) : null;

  const body = (
    <>
      <View style={Platform.OS === "web" ? null : { paddingHorizontal: headingPadding }}>
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
        onRefDragStart={refDrag}
        onQuickCreate={quickCreate.onQuickCreate}
        onFormatStateChange={setFormatState}
        onFocusChange={handleFocusChange}
        onAiShortcut={aiOn ? () => assist.start("generate") : undefined}
        onAiToolbarPress={aiOn ? assist.openMenu : undefined}
        // Desktop injects a Wails-backed native table menu; web uses the built-in HTML popup.
        tableMenuPresenter={tableMenuPresenter()}
        ink={{
          groups: ink.groups,
          tool: drawing ? tool : null,
          onSave: ink.save,
          onDelete: ink.remove,
          onStateChange: setInkState,
          onExitRequest: exitDrawing,
        }}
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
        {drawingBar}
        {!drawing ? <NoteAiDock assist={assist} note={note} /> : null}
        {quickCreate.dialog}
      </View>
    );
  }

  return (
    <View ref={dropRef} style={styles.page}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={touch ? styles.docScrollTouch : styles.docScroll}>
        <TourAnchor id="today.note" style={styles.doc}>
          {body}
        </TourAnchor>
      </ScrollView>
      {/* The bar is pinned under the document as the column's last row. A pointer keeps it
          up permanently; touch web only shows it while the editor has focus. */}
      {!drawing ? <NoteAiDock assist={assist} note={note} /> : null}
      {drawingBar ??
        (!touch || editorFocused ? (
          <FormattingBar
            state={formatState}
            editorRef={editorRef}
            canAttach={!!documentSource}
            onAi={aiOn ? () => (assist.phase?.kind === "menu" ? assist.close() : assist.openMenu()) : undefined}
            aiActive={!!assist.phase}
          />
        ) : null)}
      {quickCreate.dialog}
    </View>
  );
}

/** Desktop aside wrapper: the mini calendar over the selected day's agenda. The agenda owns
 *  the rest of the pane's height — its day grid scrolls on its own — so the pane itself doesn't
 *  scroll. Sync state lives in the shell's status bar, not here. The SplitView draws the
 *  hairline; this pane is flat. */
function CalendarPane(props: {
  selected: string;
  today: string;
  /** False while this tab sits in the background — pauses the agenda grid's clock. */
  visible: boolean;
  onSelect: (date: string) => void;
  onOpenItem?: (item: CalendarItem) => void;
}) {
  return (
    <View style={styles.aside}>
      <TourAnchor id="today.calendar">
        <TodayCalendar selected={props.selected} today={props.today} onSelect={props.onSelect} />
      </TourAnchor>
      <TourAnchor id="today.agenda" style={styles.agenda}>
        <Agenda date={props.selected} onOpenItem={props.onOpenItem} creatable grid visible={props.visible} />
      </TourAnchor>
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
  // The document column: 20/28 page padding around a 720px measure, centered like the note
  // editor so the two read as the same page.
  docScroll: { paddingHorizontal: 28, paddingTop: space.xl2, paddingBottom: space.huge },
  // A phone's page, as in the note editor (NoteEditor's pageTouch).
  docScrollTouch: { paddingHorizontal: space.xl2, paddingTop: space.xl, paddingBottom: space.huge },
  doc: { maxWidth: layout.contentMax, width: "100%" as const, alignSelf: "center" as const },
  page: { flex: 1 },
  // Touch drops the desktop title for the phone's 20px semibold heading.
  headingTouch: { fontSize: font.size["2xl"], lineHeight: 24, letterSpacing: -0.5 },
  meta: { marginTop: space.xs, marginBottom: space.xl },

  aside: { flex: 1, minHeight: 0, padding: space.ml, paddingBottom: 0, backgroundColor: colors.surfaceCard },
  // The agenda owns the pane's remaining height (its day grid scrolls on its own).
  agenda: { flex: 1, minHeight: 0 },

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
