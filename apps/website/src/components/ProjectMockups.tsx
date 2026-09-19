import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ProgressRing } from "../ds";
import {
  Badge,
  C,
  CanvasBoard,
  CanvasPaneHeader,
  CanvasToolStrip,
  Checkbox,
  DocHeader,
  FieldChip,
  FieldInput,
  Glyph,
  IconBtn,
  ListPane,
  NoteChip,
  RoundCheck,
  Row,
  SANS,
  Spacer,
  StreakGrid,
  WeekView,
  displayTitle,
  eyebrow,
  hairline,
  mono,
  prose,
  type BoardEdge,
  type BoardNode,
  type CalItem,
  type WeekDay,
} from "./FeatureMockups";

// Close-ups of a project's view (packages/app ProjectView) for the landing page's project
// cards. Each is the project panel at 1:1, built from the same kit as the feature window: the
// 32px header with the task-progress ring, the row of section chips with one lit, then that
// section's list column beside its detail pane, split the way ProjectView splits them. The
// panel is laid out past the card's right and bottom edges, so every card reads as a crop of
// the same app. Each card files a different part of life into its project.

export type ProjectSection = "notes" | "tasks" | "lists" | "canvases" | "calendars" | "habits";

const SECTIONS: [ProjectSection, string][] = [
  ["notes", "Notes"],
  ["tasks", "Tasks"],
  ["lists", "Lists"],
  ["canvases", "Canvases"],
  ["calendars", "Calendars"],
  ["habits", "Habits"],
];

interface Project {
  name: string;
  color: string;
  /** Member tasks done and in total: the header's ring and "3/8 done". */
  done: number;
  total: number;
  /** The chips' counts. Tasks counts what's left to do; habits carries no count. */
  counts: Partial<Record<ProjectSection, number>>;
}

// The crop's design size. Narrower cards scale it down as a unit; wider ones show more panel.
const ART_W = 600;
const ART_H = 360;
const INSET = 20;
const BLEED = 48;

/** The project panel: header, section chips, then the section's split. */
function ProjectPanel({ project, section, children }: { project: Project; section: ProjectSection; children: ReactNode }) {
  return (
    <div
      style={{
        position: "absolute",
        top: INSET,
        left: INSET,
        right: -BLEED,
        bottom: -BLEED,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        borderRadius: 6,
        border: hairline,
        background: C.surfaceCard,
        boxShadow: "0 1px 2px rgba(17,17,16,0.04), 0 10px 28px rgba(17,17,16,0.07)",
      }}
    >
      <div style={{ height: 32, flexShrink: 0, display: "flex", alignItems: "center", gap: 8, padding: "0 6px 0 10px", borderBottom: hairline }}>
        <Glyph name="folder" size={14} color={project.color} />
        <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-0.18px", lineHeight: "20px", whiteSpace: "nowrap" }}>{project.name}</span>
        <ProgressRing value={project.done / project.total} size={14} stroke={2} color={C.accent} track={C.borderSubtle} />
        <span style={mono()}>
          {project.done}/{project.total} done
        </span>
        <Spacer />
        <IconBtn>
          <Glyph name="settings" size={13} />
        </IconBtn>
      </div>
      <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 2, padding: "4px 8px", borderBottom: hairline }}>
        {SECTIONS.map(([id, label]) => {
          const on = id === section;
          const count = project.counts[id];
          return (
            <span
              key={id}
              style={{ height: 22, display: "inline-flex", alignItems: "center", gap: 5, padding: "0 7px", borderRadius: 3, background: on ? C.surfaceSelected : "transparent" }}
            >
              <span style={{ fontSize: 12, lineHeight: "16px", color: on ? C.textAccent : C.textSecondary, whiteSpace: "nowrap" }}>{label}</span>
              {count != null ? <span style={mono(on ? C.textAccent : C.textQuaternary)}>{count}</span> : null}
            </span>
          );
        })}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>{children}</div>
    </div>
  );
}

const Detail = ({ children }: { children: ReactNode }) => <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>{children}</div>;
const SectionLabel = ({ children }: { children: ReactNode }) => <div style={{ ...eyebrow, padding: "8px 6px 3px" }}>{children}</div>;

// ---------------------------------------------------------------------------
// Notes: a renovation's notes, one open on a table of quotes.
// ---------------------------------------------------------------------------

const KITCHEN: Project = { name: "Kitchen renovation", color: "#f59e0b", done: 2, total: 6, counts: { notes: 5, tasks: 4, lists: 1, canvases: 1, calendars: 1 } };
const KITCHEN_NOTES = [
  { title: "Contractor quotes", when: "12m ago" },
  { title: "Cabinet measurements", when: "2h ago" },
  { title: "Tile and paint ideas", when: "yesterday" },
  { title: "Budget", when: "3d ago" },
  { title: "Permit checklist", when: "6d ago" },
];
const QUOTES = [
  ["Oak & Sons", "$18,400", "Nov 2"],
  ["Birch Build", "$15,900", "Jan 11"],
  ["Hale Kitchens", "$16,750", "Nov 16"],
];

/** A GFM table as the note editor draws it: hairline grid, 6px corners, a sunken header. */
function QuoteTable() {
  const cell = (last: boolean, bottom: boolean): CSSProperties => ({
    padding: "4px 8px",
    textAlign: "left",
    fontWeight: "inherit",
    whiteSpace: "nowrap",
    borderRight: last ? "none" : hairline,
    borderBottom: bottom ? "none" : hairline,
  });
  const head = ["Contractor", "Quote", "Can start"];
  return (
    <table style={{ borderCollapse: "separate", borderSpacing: 0, marginTop: 10, fontSize: 13, lineHeight: "18px", color: C.textPrimary, border: hairline, borderRadius: 6 }}>
      <thead>
        <tr style={{ fontWeight: 600 }}>
          {head.map((h, i) => (
            <th
              key={h}
              style={{
                ...cell(i === head.length - 1, false),
                background: C.surfaceSunken,
                borderTopLeftRadius: i === 0 ? 5 : 0,
                borderTopRightRadius: i === head.length - 1 ? 5 : 0,
              }}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {QUOTES.map((row, r) => (
          <tr key={row[0]}>
            {row.map((v, i) => (
              <td key={i} style={cell(i === row.length - 1, r === QUOTES.length - 1)}>
                {v}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function NotesCrop() {
  return (
    <ProjectPanel project={KITCHEN} section="notes">
      <ListPane title="Notes" count={String(KITCHEN_NOTES.length)} menu={false} width={236} input={<FieldInput icon="search" placeholder="Search notes" />}>
        {KITCHEN_NOTES.map((n, i) => (
          <Row key={n.title} selected={i === 0} lead={<Glyph name="file" size={12} color={i === 0 ? C.textAccent : C.textQuaternary} />} title={n.title} meta={n.when} />
        ))}
      </ListPane>
      <Detail>
        <DocHeader badge="v9" meta="edited 12m ago" />
        <div style={{ padding: "22px 28px 0" }}>
          <div style={displayTitle}>Contractor quotes</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "6px 0 12px" }}>
            <span style={mono(C.textTertiary)}>note · 01a4c7e2</span>
            <Badge label="+ add type" />
          </div>
          <p style={prose}>Three quotes in, all with the island.</p>
          <QuoteTable />
        </div>
      </Detail>
    </ProjectPanel>
  );
}

// ---------------------------------------------------------------------------
// Tasks: the launch's tasks by due date, its repeating task and what's done, one open.
// ---------------------------------------------------------------------------

const LAUNCH: Project = { name: "v1.2 launch", color: "#6366f1", done: 3, total: 7, counts: { notes: 4, tasks: 4, lists: 2, canvases: 1, calendars: 1 } };
const LAUNCH_TASKS = [
  { title: "Draft the launch announcement", due: "today" },
  { title: "Review pricing page copy", due: "Sep 19" },
  { title: "Record the demo", due: "Sep 21" },
  { title: "Brief support on the billing flow", due: "Sep 23" },
];
const LAUNCH_DONE = ["Pick the launch date", "Update the screenshots", "Write the pricing FAQ"];

function TasksCrop() {
  return (
    <ProjectPanel project={LAUNCH} section="tasks">
      <ListPane title="All tasks" count={String(LAUNCH_TASKS.length)} input={<FieldInput icon="plus" placeholder="Add a task, press Enter" />}>
        {LAUNCH_TASKS.map((t) => (
          <Row
            key={t.title}
            selected={t.title === "Record the demo"}
            lead={<Checkbox />}
            title={t.title}
            meta={t.due}
            metaColor={t.due === "today" ? C.textAccent : C.textQuaternary}
          />
        ))}
        <SectionLabel>Repeating · 1</SectionLabel>
        <div style={{ minHeight: 38, display: "flex", alignItems: "center", gap: 6, padding: "0 4px 0 6px" }}>
          <Glyph name="repeat" size={12} color={C.textQuaternary} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500, lineHeight: "17px", color: C.textPrimary }}>Weekly team sync</div>
            <div style={{ fontSize: 12, lineHeight: "16px", color: C.textTertiary }}>Every week on Mon · next Sep 21</div>
          </div>
        </div>
        <SectionLabel>Completed · {LAUNCH_DONE.length}</SectionLabel>
        {LAUNCH_DONE.map((title) => (
          <Row key={title} done lead={<Checkbox checked />} title={title} />
        ))}
      </ListPane>
      <Detail>
        <DocHeader badge="open" meta="edited 5m ago" />
        <div style={{ padding: "22px 28px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Checkbox size={18} border={1.5} />
            <span style={displayTitle}>Record the demo</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 28 }}>
            <FieldChip icon="calendar" label="Sep 21" clear />
            <FieldChip icon="bell" label="Sep 21, 10:00 AM" clear />
            <FieldChip icon="repeat" label="Repeat" sans outline />
          </div>
          <div
            style={{
              ...prose,
              marginLeft: 28,
              maxWidth: 440,
              minHeight: 104,
              padding: "8px 10px",
              borderRadius: 6,
              border: hairline,
              background: C.surfaceApp,
              lineHeight: "26px",
            }}
          >
            Follow the <NoteChip title="Demo script" /> and keep it under two minutes.
          </div>
        </div>
      </Detail>
    </ProjectPanel>
  );
}

// ---------------------------------------------------------------------------
// Lists: one of the wedding's lists, in priority order under two headings (ProjectLists).
// ---------------------------------------------------------------------------

const WEDDING: Project = { name: "Wedding", color: "#ec4899", done: 5, total: 19, counts: { notes: 6, tasks: 14, lists: 3, canvases: 1, calendars: 1 } };
type ListLine = { heading: string } | { title: string; due: string; done?: boolean };
const COUNTDOWN: ListLine[] = [
  { heading: "This month" },
  { title: "Book the photographer", due: "Sep 12", done: true },
  { title: "Send the invitations", due: "Sep 21" },
  { title: "Choose the menu", due: "Sep 25" },
  { title: "Order the flowers", due: "Sep 30" },
  { heading: "Final week" },
  { title: "Confirm the seating plan", due: "Oct 12" },
  { title: "Pick up the rings", due: "Oct 15" },
];

function ListsCrop() {
  return (
    <ProjectPanel project={WEDDING} section="lists">
      <div style={{ width: 260, flexShrink: 0, display: "flex", flexDirection: "column", borderRight: hairline }}>
        <div style={{ height: 32, flexShrink: 0, display: "flex", alignItems: "center", gap: 6, padding: "0 6px" }}>
          <IconBtn>
            <Glyph name="chevronLeft" size={13} />
          </IconBtn>
          <span style={{ fontSize: 13, fontWeight: 500, color: C.textPrimary }}>Countdown</span>
          <Glyph name="chevronDown" size={10} color={C.textTertiary} />
          <Spacer />
          <IconBtn>
            <Glyph name="tasks" size={13} />
          </IconBtn>
          <IconBtn>
            <Glyph name="listBullet" size={13} />
          </IconBtn>
        </div>
        <div style={{ padding: "0 6px 6px" }}>
          <FieldInput icon="plus" placeholder="Add a task, press Enter" />
        </div>
        <div style={{ padding: "0 4px", display: "flex", flexDirection: "column", gap: 1 }}>
          {COUNTDOWN.map((line) =>
            "heading" in line ? (
              <div key={line.heading} style={{ ...eyebrow, minHeight: 24, display: "flex", alignItems: "center", padding: "6px 0 0 6px" }}>
                {line.heading}
              </div>
            ) : (
              <Row key={line.title} lead={<Checkbox checked={line.done} />} title={line.title} meta={line.due} done={line.done} />
            ),
          )}
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8, padding: "20px 24px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Glyph name="listOrdered" size={16} color={C.textQuaternary} />
          <span style={displayTitle}>Countdown</span>
        </div>
        <span style={mono()}>1/6 done · 2 sublists</span>
        <span style={{ fontSize: 12, lineHeight: "18px", color: C.textTertiary }}>Select a task on the left to open it.</span>
      </div>
    </ProjectPanel>
  );
}

// ---------------------------------------------------------------------------
// Canvases: a trip's itinerary board, a leg per group.
// ---------------------------------------------------------------------------

const JAPAN: Project = { name: "Japan trip", color: "#ef4444", done: 1, total: 7, counts: { notes: 3, tasks: 6, lists: 1, canvases: 2, calendars: 1 } };
const ITINERARY: BoardNode[] = [
  { id: "tokyo", kind: "group", label: "Tokyo, days 1 to 3", color: "#ec4899", x: 12, y: 20, w: 354, h: 82 },
  { id: "flight", kind: "event", title: "Flight to Tokyo", meta: "event · sun, oct 18 · 6:40 pm", x: 24, y: 34, w: 214, h: 44 },
  { id: "ramen", kind: "sticky", text: "Ramen in Shinjuku, first night", color: "#f59e0b", x: 250, y: 34, w: 104, h: 56 },
  { id: "kyoto", kind: "group", label: "Kyoto, days 4 to 6", color: "#10b981", x: 12, y: 130, w: 354, h: 112 },
  { id: "temples", kind: "note", title: "Temples to see", excerpt: "Fushimi Inari at dawn, then Kiyomizu-dera.", x: 24, y: 146, w: 168, h: 84 },
  { id: "ryokan", kind: "task", title: "Book the ryokan", meta: "task · due sep 30", x: 204, y: 146, w: 150, h: 42 },
];
const ITINERARY_EDGES: BoardEdge[] = [{ from: "flight", fromSide: "bottom", to: "ryokan", toSide: "top", label: "day 4" }];

function CanvasesCrop() {
  return (
    <ProjectPanel project={JAPAN} section="canvases">
      <ListPane title="Canvases" count="2" menu={false} width={200} input={<FieldInput icon="search" placeholder="Search canvases" />}>
        <Row selected lead={<Glyph name="canvas" size={12} color={C.textAccent} />} title="Itinerary" meta="5m ago" />
        <Row lead={<Glyph name="canvas" size={12} color={C.textQuaternary} />} title="Food to try" meta="2d ago" />
      </ListPane>
      <Detail>
        <CanvasPaneHeader name="Itinerary" />
        <CanvasToolStrip />
        <CanvasBoard nodes={ITINERARY} edges={ITINERARY_EDGES} />
      </Detail>
    </ProjectPanel>
  );
}

// ---------------------------------------------------------------------------
// Calendars: a race's training plan and a personal calendar, merged on the project's week.
// ---------------------------------------------------------------------------

const MARATHON: Project = { name: "Half marathon", color: "#10b981", done: 1, total: 4, counts: { notes: 2, tasks: 3, lists: 0, canvases: 0, calendars: 2 } };
const TRAINING = "#14b8a6";
const PERSONAL = "#8b5cf6";
const at = (h: number, m = 0) => h * 60 + m;
const W39: WeekDay[] = [
  { name: "Sun", date: 20 },
  { name: "Mon", date: 21 },
  { name: "Tue", date: 22 },
  { name: "Wed", date: 23 },
  { name: "Thu", date: 24 },
  { name: "Fri", date: 25 },
  { name: "Sat", date: 26 },
];
const TRAINING_WEEK: CalItem[] = [
  { day: 0, kind: "event", title: "Long run 16k", start: at(7), end: at(8, 40), color: TRAINING },
  { day: 1, kind: "event", title: "Strength", start: at(7), end: at(7, 45), color: TRAINING },
  { day: 1, kind: "task", title: "Buy new shoes", start: at(9) },
  { day: 2, kind: "event", title: "Intervals", start: at(6, 30), end: at(7, 30), color: TRAINING },
  { day: 2, kind: "event", title: "Physio", start: at(10), end: at(10, 45), color: PERSONAL },
  { day: 3, kind: "event", title: "Easy run 6k", start: at(7), end: at(7, 40), color: TRAINING },
  { day: 5, kind: "event", title: "Tempo run 8k", start: at(7), end: at(7, 50), color: TRAINING },
];

/** A calendar the project holds: its swatch, name and source, and the button that takes it
 *  out of the project (ProjectCalendarRows). */
function HeldCalendar({ color, title, subtitle }: { color: string; title: string; subtitle: string }) {
  return (
    <div style={{ minHeight: 38, display: "flex", alignItems: "center", gap: 6, padding: "0 2px 0 6px", borderRadius: 3 }}>
      <span style={{ width: 8, height: 8, flexShrink: 0, margin: "0 2px", borderRadius: 2, background: color }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, lineHeight: "17px", color: C.textPrimary }}>{title}</div>
        <div style={{ fontSize: 12, lineHeight: "16px", color: C.textTertiary, whiteSpace: "nowrap" }}>{subtitle}</div>
      </div>
      <IconBtn>
        <Glyph name="close" size={12} color={C.textTertiary} />
      </IconBtn>
    </div>
  );
}

function CalendarsCrop() {
  return (
    <ProjectPanel project={MARATHON} section="calendars">
      <ListPane title="Calendars" count="2" menu={false} width={200}>
        <HeldCalendar color={TRAINING} title="Training plan" subtitle="Subscription · read-only" />
        <HeldCalendar color={PERSONAL} title="Personal" subtitle="iCloud" />
      </ListPane>
      {/* Three days fill the card at its design width; wider cards show more of the week. */}
      <WeekView month="September 2026" week="w39" days={W39} items={TRAINING_WEEK} scrollTop={6 * 34 - 8} colWidth={113} />
    </ProjectPanel>
  );
}

// ---------------------------------------------------------------------------
// Habits: the planned screen (the app holds a placeholder here for now), drawn like the
// feature window's Habits: a language's daily habits, one open on its streak.
// ---------------------------------------------------------------------------

const SPANISH: Project = { name: "Learn Spanish", color: "#8b5cf6", done: 1, total: 2, counts: { notes: 6, tasks: 1, lists: 0, canvases: 1, calendars: 0 } };
const SPANISH_HABITS = [
  { title: "Daily practice", streak: "23d", done: true },
  { title: "Read one article", streak: "6d", done: true },
  { title: "Learn five new words", streak: "9d", done: false },
  { title: "Watch a show in Spanish", streak: "2d", done: false },
];

function HabitsCrop() {
  return (
    <ProjectPanel project={SPANISH} section="habits">
      <ListPane title="Habits" count={String(SPANISH_HABITS.length)} menu={false} width={228}>
        {SPANISH_HABITS.map((h, i) => (
          <Row
            key={h.title}
            selected={i === 0}
            lead={<RoundCheck done={h.done} />}
            title={h.title}
            meta={h.streak}
            metaColor={h.done ? C.textAccent : C.textQuaternary}
          />
        ))}
      </ListPane>
      <Detail>
        <DocHeader badge="23-day streak" meta="checked in 7:48 AM" />
        <div style={{ padding: "20px 28px", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <RoundCheck done size={20} />
            <span style={displayTitle}>Daily practice</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 30 }}>
            <FieldChip icon="repeat" label="every day" />
            <FieldChip icon="bell" label="7:30 AM" clear />
          </div>
          <div style={{ paddingLeft: 30, display: "flex", flexDirection: "column", gap: 10 }}>
            <span style={mono(C.textTertiary)}>streak 23 · best 31 · 28 of the last 30 days</span>
            <StreakGrid streak={23} seed={53} />
          </div>
        </div>
      </Detail>
    </ProjectPanel>
  );
}

// ---------------------------------------------------------------------------

const CROPS: Record<ProjectSection, { label: string; Crop: () => ReactNode }> = {
  notes: { label: "A kitchen renovation project's notes in Companion, with a note of contractor quotes open", Crop: NotesCrop },
  tasks: { label: "A launch project's tasks in Companion: due dates, a repeating task and completed tasks, with one task open", Crop: TasksCrop },
  lists: { label: "A wedding project's task list in Companion, ordered by priority under two headings", Crop: ListsCrop },
  canvases: { label: "A trip project's canvas in Companion: a flight, a task, a note and a sticky in two groups joined by an arrow", Crop: CanvasesCrop },
  calendars: { label: "A half marathon project's calendar in Companion: a training plan and a personal calendar on one week", Crop: CalendarsCrop },
  habits: { label: "A language project's habits in Companion, with a 23-day streak open", Crop: HabitsCrop },
};

/** One card's crop, scaled down as a unit below its design width. */
export function ProjectMockup({ section }: { section: ProjectSection }) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(ART_W);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const fit = () => setWidth(el.clientWidth || ART_W);
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const scale = Math.min(1, width / ART_W);
  const { label, Crop } = CROPS[section];
  return (
    <div
      ref={frame}
      role="img"
      aria-label={label}
      style={{ position: "relative", width: "100%", aspectRatio: `${ART_W} / ${ART_H}`, maxHeight: ART_H, overflow: "hidden", userSelect: "none", background: C.surfaceApp }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: width / scale,
          height: ART_H,
          transform: scale < 1 ? `scale(${scale})` : undefined,
          transformOrigin: "0 0",
          fontFamily: SANS,
          color: C.textPrimary,
        }}
      >
        <Crop />
      </div>
    </div>
  );
}
