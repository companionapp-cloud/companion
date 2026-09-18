import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { BrandMark, Icon, type IconName } from "../ds";

// In-browser product mockups shown inside the landing page's "safari window". Each one is
// the web app's desktop layout drawn at 1:1 — the 44px icon rail, the tab toolbar, the inset
// panel and the mono status strip — with each feature's screen rebuilt from the real
// components (packages/app: ChatScreen, NoteEditor, TaskEditor, GraphView). The window is
// laid out at a fixed 978×480 and scaled down as a whole on narrower screens, so it always
// reads like a screenshot of the app rather than a reflowed approximation.

export type FeatureKey = "chat" | "notes" | "tasks" | "habits" | "graph";

// The app's dense-redesign values (packages/design-system: palette.ts, tokens.ts). The site's
// own ds snapshot is deliberately airier, so the mockups carry the app's numbers instead.
const C = {
  textPrimary: "#1a1a18",
  textSecondary: "#595954",
  textTertiary: "#7b7b75",
  textQuaternary: "#a7a7a1",
  textAccent: "#e04e02",
  surfaceApp: "#f5f5f3",
  surfaceCard: "#ffffff",
  surfaceSunken: "#ededea",
  surfaceActive: "#e0e0dc",
  surfaceSelected: "#fff4ed",
  borderSubtle: "#e0e0dc",
  borderDefault: "#cececa",
  borderStrong: "#a7a7a1",
  accent: "#f76808",
  accentSoft: "#fff4ed",
  accentSoftBorder: "#feccab",
  onAccent: "#ffffff",
  success: "#2e9e5b",
  warning: "#d68a0c",
  info: "#3b74d6",
  avatar: "#3e3e3a",
  meeting: "#6e56cf",
};
const SANS = "'Geist', ui-sans-serif, system-ui, sans-serif";
const MONO = "'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace";

const W = 978;
const H = 480;

const mono = (color = C.textQuaternary, size = 11): CSSProperties => ({
  fontFamily: MONO,
  fontSize: size,
  lineHeight: `${Math.round(size * 1.35)}px`,
  color,
  whiteSpace: "nowrap",
});
const eyebrow: CSSProperties = { ...mono(C.textQuaternary, 10), fontWeight: 600, letterSpacing: 1.2, textTransform: "uppercase" };
const ellipsis: CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const hairline = `1px solid ${C.borderSubtle}`;
const displayTitle: CSSProperties = { fontSize: 30, fontWeight: 600, letterSpacing: "-0.75px", lineHeight: "34px", color: C.textPrimary };

function Glyph({ name, size = 14, color = C.textSecondary, strokeWidth = 1.5 }: { name: IconName; size?: number; color?: string; strokeWidth?: number }) {
  return <Icon name={name} size={size} color={color} strokeWidth={strokeWidth} />;
}

function IconBtn({ children, active }: { children: ReactNode; active?: boolean }) {
  return (
    <span
      style={{
        width: 22,
        height: 22,
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 3,
        background: active ? C.surfaceActive : "transparent",
      }}
    >
      {children}
    </span>
  );
}

function Badge({ label, accent }: { label: string; accent?: boolean }) {
  return (
    <span
      style={{
        ...mono(accent ? C.textAccent : C.textTertiary),
        lineHeight: "14px",
        display: "inline-flex",
        alignItems: "center",
        height: 16,
        padding: "0 5px",
        flexShrink: 0,
        borderRadius: 3,
        border: `1px solid ${accent ? C.accentSoftBorder : C.borderSubtle}`,
        background: accent ? C.accentSoft : C.surfaceSunken,
      }}
    >
      {label}
    </span>
  );
}

const Spacer = () => <span style={{ flex: 1 }} />;
const VDivider = ({ height = 10 }: { height?: number }) => <span style={{ width: 1, height, flexShrink: 0, background: C.borderSubtle }} />;

// ---------------------------------------------------------------------------
// Shell: rail · tab toolbar · inset panel · status strip (AppShell + Frame).
// ---------------------------------------------------------------------------

const RAIL: { id: FeatureKey | "today" | "calendar" | "canvases"; icon: IconName }[] = [
  { id: "today", icon: "today" },
  { id: "chat", icon: "chat" },
  { id: "calendar", icon: "calendar" },
  { id: "notes", icon: "notes" },
  { id: "tasks", icon: "tasks" },
  { id: "canvases", icon: "canvas" },
  { id: "habits", icon: "habits" },
  { id: "graph", icon: "graph" },
];

function RailSquare({ icon, active }: { icon: IconName; active?: boolean }) {
  return (
    <span
      style={{
        width: 28,
        height: 28,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 3,
        background: active ? C.accentSoft : "transparent",
      }}
    >
      <Glyph name={icon} size={16} color={active ? C.textAccent : C.textSecondary} />
    </span>
  );
}

function Rail({ active }: { active: FeatureKey }) {
  return (
    <div style={{ width: 44, flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 1, padding: "9px 0 8px" }}>
      <div style={{ height: 18, marginBottom: 12 }}>
        <BrandMark size={18} />
      </div>
      {RAIL.map((item) => (
        <RailSquare key={item.id} icon={item.icon} active={item.id === active} />
      ))}
      <Spacer />
      <RailSquare icon="trash" />
      <RailSquare icon="settings" />
    </div>
  );
}

interface TabSpec {
  icon: IconName;
  label: string;
  active?: boolean;
  /** Documents get the pop-out-to-a-window affordance; views don't. */
  doc?: boolean;
}

function TabAffordance({ icon }: { icon: IconName }) {
  return (
    <span style={{ width: 16, height: 16, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
      <Glyph name={icon} size={10} strokeWidth={2} color={C.textTertiary} />
    </span>
  );
}

function Tab({ icon, label, active, doc }: TabSpec) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        height: 24,
        maxWidth: 170,
        flexShrink: 0,
        padding: "0 3px 0 7px",
        borderRadius: 3,
        border: `1px solid ${active ? C.borderSubtle : "transparent"}`,
        background: active ? C.surfaceCard : "transparent",
      }}
    >
      <Glyph name={icon} size={12} color={C.textTertiary} />
      <span style={{ ...ellipsis, fontSize: 12, lineHeight: "16px", color: active ? C.textPrimary : C.textSecondary }}>{label}</span>
      {doc ? <TabAffordance icon="external" /> : null}
      <TabAffordance icon="close" />
    </span>
  );
}

function Toolbar({ tabs }: { tabs: TabSpec[] }) {
  return (
    <div style={{ height: 36, flexShrink: 0, display: "flex", alignItems: "center", gap: 6, padding: "0 12px" }}>
      <IconBtn>
        <Glyph name="chevronLeft" color={C.textTertiary} />
      </IconBtn>
      <IconBtn>
        <Glyph name="chevronRight" color={C.textQuaternary} />
      </IconBtn>
      <span style={{ margin: "0 4px", display: "flex" }}>
        <VDivider height={16} />
      </span>
      {tabs.map((t) => (
        <Tab key={t.label} {...t} />
      ))}
      <IconBtn>
        <Glyph name="plus" color={C.textTertiary} />
      </IconBtn>
      <Spacer />
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 22, padding: "0 6px" }}>
        <Glyph name="capture" />
        <span style={{ fontSize: 13, fontWeight: 500, color: C.textPrimary }}>Capture</span>
        <span style={mono(C.textQuaternary, 10)}>⌥⇧␣</span>
      </span>
      <IconBtn>
        <Glyph name="moon" />
      </IconBtn>
      <IconBtn>
        <Glyph name="bell" />
      </IconBtn>
    </div>
  );
}

/** Signed in to Companion Cloud with an encrypted account — what ShellStatusBar prints then. */
function StatusBar({ tabCount }: { tabCount: number }) {
  return (
    <div
      style={{
        height: 22,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "0 12px",
        borderTop: hairline,
        background: C.surfaceApp,
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: C.success, flexShrink: 0 }} />
      <span style={mono()}>synced 12s ago</span>
      <VDivider />
      <span style={mono()}>portal.companionapp.cloud</span>
      <VDivider />
      <span style={mono()}>{tabCount === 1 ? "1 tab open" : `${tabCount} tabs open`}</span>
      <Spacer />
      <span style={mono()}>e2e encrypted</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared pieces: list column, dense rows, document header, inline chips.
// ---------------------------------------------------------------------------

function ListPane({ title, count, plus = true, input, children }: { title: string; count: string; plus?: boolean; input?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ width: 260, flexShrink: 0, display: "flex", flexDirection: "column", borderRight: hairline }}>
      <div style={{ height: 32, flexShrink: 0, display: "flex", alignItems: "center", gap: 6, padding: "0 6px 0 10px" }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: C.textPrimary }}>{title}</span>
        <Glyph name="chevronDown" size={10} color={C.textTertiary} />
        <Spacer />
        <span style={mono()}>{count}</span>
        {plus ? (
          <IconBtn>
            <Glyph name="plus" size={12} />
          </IconBtn>
        ) : null}
      </div>
      {input ? <div style={{ padding: "0 6px 6px" }}>{input}</div> : null}
      <div style={{ padding: "0 4px", display: "flex", flexDirection: "column", gap: 1 }}>{children}</div>
    </div>
  );
}

function FieldInput({ icon, placeholder }: { icon: IconName; placeholder: string }) {
  return (
    <div
      style={{
        height: 22,
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "0 6px",
        borderRadius: 4,
        border: `1px solid ${C.borderDefault}`,
        background: C.surfaceCard,
      }}
    >
      <Glyph name={icon} size={12} color={C.textQuaternary} />
      <span style={{ fontSize: 13, color: C.textQuaternary }}>{placeholder}</span>
    </div>
  );
}

function Row({ lead, title, meta, metaColor, selected }: { lead: ReactNode; title: string; meta?: string; metaColor?: string; selected?: boolean }) {
  return (
    <div
      style={{
        height: 24,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "0 4px 0 6px",
        borderRadius: 3,
        background: selected ? C.surfaceSelected : "transparent",
      }}
    >
      {lead}
      <span style={{ ...ellipsis, flex: 1, fontSize: 13, fontWeight: 500, color: selected ? C.textAccent : C.textPrimary }}>{title}</span>
      {meta ? <span style={mono(metaColor)}>{meta}</span> : null}
    </div>
  );
}

const Checkbox = ({ size = 12, border = 1 }: { size?: number; border?: number }) => (
  <span style={{ width: size, height: size, flexShrink: 0, borderRadius: size > 14 ? 3 : 2, border: `${border}px solid ${C.borderStrong}`, background: C.surfaceCard }} />
);

function DocHeader({ badge, meta }: { badge: string; meta: string }) {
  return (
    <div style={{ height: 28, flexShrink: 0, display: "flex", alignItems: "center", gap: 6, padding: "0 6px 0 10px", borderBottom: hairline }}>
      <Badge label={badge} accent />
      <span style={mono(C.textTertiary)}>{meta}</span>
      <Spacer />
      {(["folder", "graph", "panelRight", "trash"] as const).map((name) => (
        <IconBtn key={name}>
          <Glyph name={name} />
        </IconBtn>
      ))}
    </div>
  );
}

const chipBox: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  height: 20,
  padding: "0 6px",
  margin: "0 1px",
  verticalAlign: "middle",
  borderRadius: 3,
  border: hairline,
  background: C.surfaceApp,
};

/** A `[[task:…]]` reference in prose: checkbox, title, due date, reminder. */
function TaskChip({ title, due, remind }: { title: string; due?: string; remind?: string }) {
  return (
    <span style={chipBox}>
      <Checkbox size={11} />
      <span style={mono(C.textSecondary)}>{title}</span>
      {due ? <span style={mono()}>{due}</span> : null}
      {remind ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
          <Glyph name="bell" size={10} color={C.textQuaternary} />
          <span style={mono()}>{remind}</span>
        </span>
      ) : null}
    </span>
  );
}

/** A `[[note:…]]` reference in prose. */
function NoteChip({ title }: { title: string }) {
  return (
    <span style={chipBox}>
      <Glyph name="link" size={11} color={C.textQuaternary} />
      <span style={mono(C.textSecondary)}>{title}</span>
    </span>
  );
}

/** A field chip in a document's meta row (due date, reminder, cadence). */
function FieldChip({ icon, label, clear, sans, outline }: { icon?: IconName; label: string; clear?: boolean; sans?: boolean; outline?: boolean }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 22,
        flexShrink: 0,
        padding: clear ? "0 4px 0 7px" : "0 7px",
        borderRadius: 3,
        border: hairline,
        background: outline ? C.surfaceCard : C.surfaceSunken,
      }}
    >
      {icon ? <Glyph name={icon} size={12} color={C.textTertiary} /> : null}
      <span style={sans ? { fontSize: 13, color: C.textSecondary, whiteSpace: "nowrap" } : mono(C.textSecondary)}>{label}</span>
      {clear ? <Glyph name="close" size={10} strokeWidth={2} color={C.textQuaternary} /> : null}
    </span>
  );
}

const prose: CSSProperties = { fontSize: 14, lineHeight: "24px", color: C.textPrimary, margin: 0 };

// ---------------------------------------------------------------------------
// Chat — chat list column + a thread: a turn from Claude Code, hosted on the desktop.
// ---------------------------------------------------------------------------

const CHATS = [
  { title: "What's left before launch?", when: "just now" },
  { title: "Summarize Monday's sync", when: "2h ago" },
  { title: "Reading list for the offsite", when: "yesterday" },
  { title: "Draft the pricing FAQ", when: "3d ago" },
];

function Message({ who, children }: { who: "you" | "companion"; children: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8, width: "100%", maxWidth: 640, alignSelf: "center" }}>
      {who === "you" ? (
        <span
          style={{
            width: 18,
            height: 18,
            flexShrink: 0,
            borderRadius: "50%",
            background: C.avatar,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            ...mono(C.onAccent, 9),
            fontWeight: 600,
          }}
        >
          A
        </span>
      ) : (
        <BrandMark size={18} />
      )}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <div style={{ height: 18, display: "flex", alignItems: "center" }}>
          <span style={mono()}>{who}</span>
        </div>
        <div style={{ fontSize: 14, lineHeight: "21px", color: C.textPrimary }}>{children}</div>
      </div>
    </div>
  );
}

function ActionLine({ children }: { children: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", maxWidth: 640, alignSelf: "center", paddingLeft: 26 }}>
      <Glyph name="check" size={12} color={C.textQuaternary} />
      <span style={mono()}>{children}</span>
    </div>
  );
}

const LinkText = ({ children }: { children: string }) => (
  <span style={{ color: C.textAccent, fontWeight: 500, textDecoration: "underline", textDecorationColor: C.accentSoftBorder, textUnderlineOffset: 3 }}>
    {children}
  </span>
);

function ChatScreen() {
  return (
    <>
      <div style={{ width: 220, flexShrink: 0, display: "flex", flexDirection: "column", borderRight: hairline }}>
        <div style={{ height: 28, flexShrink: 0, display: "flex", alignItems: "center", gap: 6, padding: "0 6px 0 10px", borderBottom: hairline }}>
          <span style={{ flex: 1, fontSize: 13, fontWeight: 500, color: C.textPrimary }}>Chats</span>
          <span style={mono()}>{CHATS.length}</span>
          <IconBtn>
            <Glyph name="plus" size={12} />
          </IconBtn>
        </div>
        <div style={{ padding: 4, display: "flex", flexDirection: "column", gap: 1 }}>
          {CHATS.map((c, i) => (
            <Row
              key={c.title}
              selected={i === 0}
              lead={<Glyph name="chat" size={12} color={i === 0 ? C.textAccent : C.textQuaternary} />}
              title={c.title}
              meta={c.when}
            />
          ))}
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ height: 28, flexShrink: 0, display: "flex", alignItems: "center", gap: 6, padding: "0 6px 0 10px", borderBottom: hairline }}>
          <span style={{ ...ellipsis, flex: 1, fontSize: 13, fontWeight: 500, color: C.textPrimary }}>What's left before launch?</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, height: 20, padding: "0 4px" }}>
              <span style={mono()}>sonnet</span>
              <Glyph name="chevronDown" size={10} color={C.textQuaternary} />
            </span>
            <span style={mono()}>·</span>
            <span style={{ ...mono(), paddingLeft: 4 }}>Claude Code</span>
          </span>
          <IconBtn>
            <Glyph name="settings" size={13} />
          </IconBtn>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: 14, padding: "16px 20px" }}>
          <Message who="you">What's left before Thursday's launch? Add anything that isn't tracked yet.</Message>
          <ActionLine>searched your notes</ActionLine>
          <ActionLine>checked your tasks</ActionLine>
          <ActionLine>created a task</ActionLine>
          <Message who="companion">
            Two things stand between you and Thursday: the pricing page copy and the announcement draft. Briefing support on
            the billing flow was in <LinkText>Launch plan — v1.2</LinkText> but not tracked, so I added{" "}
            <LinkText>Brief support on the billing flow</LinkText> for Wednesday.
          </Message>
        </div>

        <div style={{ flexShrink: 0, display: "flex", alignItems: "flex-end", gap: 6, padding: 8, borderTop: hairline }}>
          <div
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 26,
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "0 6px",
              borderRadius: 4,
              border: `1px solid ${C.borderDefault}`,
              background: C.surfaceCard,
            }}
          >
            <span style={{ ...ellipsis, flex: 1, fontSize: 14, color: C.textPrimary }}>Move the investor update to Monday</span>
            <span style={{ ...mono(C.textTertiary, 10), lineHeight: "14px", padding: "0 4px", borderRadius: 3, border: hairline, background: C.surfaceApp }}>⏎</span>
          </div>
          <span
            style={{
              height: 26,
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              padding: "0 12px",
              borderRadius: 4,
              background: C.accent,
              color: C.onAccent,
              fontSize: 13,
              fontWeight: 500,
            }}
          >
            Send
          </span>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Notes — the notes list and the editor: a plan linking to the tasks it tracks.
// ---------------------------------------------------------------------------

const NOTES = [
  { title: "Launch plan — v1.2", when: "2m ago" },
  { title: "Pricing page positioning", when: "1h ago" },
  { title: "Launch sync — Monday", when: "3h ago" },
  { title: "Reading notes: Deep Work", when: "yesterday" },
  { title: "Offsite ideas", when: "2d ago" },
  { title: "Onboarding checklist", when: "5d ago" },
];

function FormattingBar() {
  const tools: (IconName | "|")[] = ["bold", "italic", "strikethrough", "code", "codeBlock", "quote", "listBullet", "listOrdered", "|", "table", "image", "link"];
  return (
    <div style={{ height: 28, flexShrink: 0, display: "flex", alignItems: "center", gap: 1, padding: "0 10px", borderTop: hairline }}>
      {tools.map((t, i) =>
        t === "|" ? (
          <span key={i} style={{ margin: "0 6px", display: "flex" }}>
            <VDivider height={14} />
          </span>
        ) : (
          <IconBtn key={t}>
            <Glyph name={t} />
          </IconBtn>
        ),
      )}
      <Spacer />
      <span style={mono()}>markdown · ⌘B ⌘I ⌘K</span>
    </div>
  );
}

function NotesScreen() {
  return (
    <>
      <ListPane title="All notes" count={String(NOTES.length)} input={<FieldInput icon="search" placeholder="Search notes" />}>
        {NOTES.map((n, i) => (
          <Row key={n.title} selected={i === 0} lead={<Glyph name="file" size={12} color={i === 0 ? C.textAccent : C.textQuaternary} />} title={n.title} meta={n.when} />
        ))}
      </ListPane>

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <DocHeader badge="v14" meta="edited 2m ago" />
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden", padding: "24px 28px 0" }}>
          <div style={displayTitle}>Launch plan — v1.2</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "6px 0 14px" }}>
            <span style={mono(C.textTertiary)}>note · 01a0b2c7</span>
            <Badge label="+ add type" />
          </div>
          <p style={prose}>Shipping v1.2 at the end of the month. Risks are mostly on the pricing page.</p>
          <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.3px", lineHeight: "26px", color: C.textPrimary, margin: "16px 0 4px" }}>
            What has to happen
          </div>
          <ul style={{ ...prose, paddingLeft: 22 }}>
            <li>Finish the pricing page copy</li>
            <li>Line up the announcement post</li>
            <li>Brief support on the new billing flow</li>
          </ul>
          <p style={{ ...prose, marginTop: 8, lineHeight: "28px" }}>
            Tracking the work in <TaskChip title="Review pricing page copy" due="Sep 19" remind="Sep 19, 9:00 AM" /> and{" "}
            <TaskChip title="Draft the launch announcement" due="Sep 18" />, decided in <NoteChip title="Launch sync — Monday" />.
          </p>
        </div>
        <FormattingBar />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Tasks — the task list (with its repeating section) and the task editor.
// ---------------------------------------------------------------------------

const TASKS = [
  { title: "Draft the launch announcement", due: "today", today: true },
  { title: "Review pricing page copy", due: "Sep 19" },
  { title: "Brief support on the billing flow", due: "Sep 23" },
  { title: "Send the investor update", due: "Sep 24" },
  { title: "Book the offsite venue", due: "Oct 2" },
];

function TasksScreen() {
  return (
    <>
      <ListPane title="All tasks" count={String(TASKS.length)} plus={false} input={<FieldInput icon="plus" placeholder="Add a task, press Enter" />}>
        {TASKS.map((t, i) => (
          <Row key={t.title} selected={i === 1} lead={<Checkbox />} title={t.title} meta={t.due} metaColor={t.today ? C.textAccent : C.textQuaternary} />
        ))}
        <div style={{ padding: "12px 6px 4px" }}>
          <span style={eyebrow}>Repeating · 1</span>
        </div>
        <div style={{ minHeight: 38, display: "flex", alignItems: "center", gap: 6, padding: "0 4px 0 6px" }}>
          <Glyph name="repeat" size={12} color={C.textQuaternary} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500, lineHeight: "17px", color: C.textPrimary }}>Weekly team sync</div>
            <div style={{ fontSize: 12, lineHeight: "16px", color: C.textTertiary }}>Every week on Mon · next Sep 21</div>
          </div>
        </div>
      </ListPane>

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <DocHeader badge="open" meta="edited 2m ago" />
        <div style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Checkbox size={18} border={1.5} />
            <span style={displayTitle}>Review pricing page copy</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 28 }}>
            <FieldChip icon="calendar" label="Sep 19" clear />
            <FieldChip icon="bell" label="Sep 19, 9:00 AM" clear />
            <FieldChip icon="repeat" label="Repeat" sans outline />
            <Badge label="+ add type" />
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
            Priya's draft is in <NoteChip title="Pricing page positioning" />. Check the annual toggle and the self-host row
            before it ships.
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Habits — the app only has a placeholder here so far ("Habits, streaks, and gentle
// nudges are on the way"), so this is the planned screen drawn in the same dense language:
// the list/detail split, a check-in, and a streak grid.
// ---------------------------------------------------------------------------

const HABITS = [
  { title: "Read 20 pages", streak: "12d", done: true },
  { title: "Move 30 minutes", streak: "4d", done: true },
  { title: "Meditate", streak: "7d", done: false },
  { title: "No phone before 9", streak: "2d", done: false },
];

const WEEKS = 16;
const TODAY = (WEEKS - 1) * 7 + 4; // Friday of the last week
const STREAK = 12;

/** A fixed, plausible check-in history: mostly done, the odd miss, a 12-day current run. */
function checkedIn(i: number): boolean | null {
  if (i > TODAY) return null;
  if (i > TODAY - STREAK) return true;
  if (i === TODAY - STREAK) return false;
  return (i * 37 + 11) % 10 < 7;
}

function RoundCheck({ done, size = 12 }: { done: boolean; size?: number }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: "50%",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        border: `1.5px solid ${done ? C.accent : C.borderStrong}`,
        background: done ? C.accent : C.surfaceCard,
      }}
    >
      {done ? <Glyph name="check" size={size - 5} strokeWidth={3} color={C.onAccent} /> : null}
    </span>
  );
}

function StreakGrid() {
  const cell = 12;
  const gap = 3;
  const months: [number, string][] = [
    [0, "Jun"],
    [4, "Jul"],
    [8, "Aug"],
    [13, "Sep"],
  ];
  return (
    <div style={{ display: "flex", gap: 8 }}>
      <div style={{ display: "flex", flexDirection: "column", gap, paddingTop: 16 }}>
        {["M", "", "W", "", "F", "", ""].map((d, i) => (
          <span key={i} style={{ ...mono(C.textQuaternary, 10), height: cell, lineHeight: `${cell}px` }}>
            {d}
          </span>
        ))}
      </div>
      <div>
        <div style={{ position: "relative", height: 16 }}>
          {months.map(([w, m]) => (
            <span key={m} style={{ ...mono(C.textQuaternary, 10), position: "absolute", left: w * (cell + gap) }}>
              {m}
            </span>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateRows: `repeat(7, ${cell}px)`, gridAutoFlow: "column", gridAutoColumns: `${cell}px`, gap }}>
          {Array.from({ length: WEEKS * 7 }, (_, i) => {
            const state = checkedIn(i);
            return (
              <span
                key={i}
                style={{
                  borderRadius: 2,
                  background: state === null ? "transparent" : state ? C.accent : C.surfaceSunken,
                  border: state === null ? `1px dashed ${C.borderSubtle}` : "none",
                  boxShadow: i === TODAY ? `0 0 0 1.5px ${C.surfaceCard}, 0 0 0 2.5px ${C.accentSoftBorder}` : undefined,
                }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function HabitsScreen() {
  return (
    <>
      <ListPane title="All habits" count={String(HABITS.length)}>
        {HABITS.map((h, i) => (
          <Row key={h.title} selected={i === 0} lead={<RoundCheck done={h.done} />} title={h.title} meta={h.streak} metaColor={h.done ? C.textAccent : C.textQuaternary} />
        ))}
      </ListPane>

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <DocHeader badge="12-day streak" meta="checked in 8:12 PM" />
        <div style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <RoundCheck done size={20} />
            <span style={displayTitle}>Read 20 pages</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 30 }}>
            <FieldChip icon="repeat" label="every day" />
            <FieldChip icon="bell" label="8:00 PM" clear />
            <Badge label="+ add type" />
          </div>
          <div style={{ paddingLeft: 30, display: "flex", flexDirection: "column", gap: 10 }}>
            <span style={mono(C.textTertiary)}>streak 12 · best 21 · 26 of the last 30 days</span>
            <span style={eyebrow}>Last {WEEKS} weeks</span>
            <StreakGrid />
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Graph — the force-directed map, fitted: circles sized by degree, dashed links.
// ---------------------------------------------------------------------------

type NodeType = "note" | "task" | "project" | "meeting";
type GraphNode = { id: string; x: number; y: number; label: string; type: NodeType; degree: number };

// Canvas-space centres (the canvas is 908×358 inside the panel).
const GRAPH_NODES: GraphNode[] = [
  { id: "plan", x: 430, y: 160, label: "Launch plan — v1.2", type: "note", degree: 6 },
  { id: "project", x: 560, y: 215, label: "v1.2 launch", type: "project", degree: 6 },
  { id: "positioning", x: 540, y: 75, label: "Pricing page positioning", type: "note", degree: 2 },
  { id: "review", x: 720, y: 105, label: "Review pricing page copy", type: "task", degree: 2 },
  { id: "draft", x: 470, y: 285, label: "Draft the launch announcement", type: "task", degree: 2 },
  { id: "investor", x: 760, y: 205, label: "Send the investor update", type: "task", degree: 1 },
  { id: "weekly", x: 680, y: 300, label: "Weekly team sync", type: "task", degree: 1 },
  { id: "sync", x: 300, y: 90, label: "Launch sync — Monday", type: "meeting", degree: 1 },
  { id: "daily", x: 280, y: 225, label: "September 18, 2026", type: "note", degree: 1 },
];

const GRAPH_EDGES: [string, string][] = [
  ["plan", "positioning"],
  ["plan", "review"],
  ["plan", "draft"],
  ["plan", "sync"],
  ["plan", "daily"],
  ["plan", "project"],
  ["project", "positioning"],
  ["project", "review"],
  ["project", "draft"],
  ["project", "investor"],
  ["project", "weekly"],
];

const NODE_STYLE: Record<NodeType, { color: string; icon: IconName }> = {
  note: { color: C.success, icon: "notes" },
  task: { color: C.info, icon: "tasks" },
  project: { color: C.accent, icon: "folder" },
  // A note typed as a Meeting: its archetype's color and icon.
  meeting: { color: C.meeting, icon: "chat" },
};

// The fitted view's zoom over GraphView's 1:1 sizes (diameter 32 + 6/degree, max 72; 11px labels).
const ZOOM = 1.1;
const nodeSize = (degree: number) => Math.round(Math.min(72, 32 + degree * 6) * ZOOM);

const LEGEND: [string, string][] = [
  ["notes", C.success],
  ["tasks", C.info],
  ["canvases", C.warning],
  ["projects", C.accent],
  ["files", C.textTertiary],
];

function GraphScreen() {
  const byId = Object.fromEntries(GRAPH_NODES.map((n) => [n.id, n]));
  return (
    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ height: 28, flexShrink: 0, display: "flex", alignItems: "center", gap: 6, padding: "0 6px 0 10px", borderBottom: hairline }}>
        <span style={mono(C.textTertiary)}>
          {GRAPH_NODES.length} nodes · {GRAPH_EDGES.length} links
        </span>
        <Spacer />
        <span style={{ ...mono(), marginRight: 4 }}>repel 2400 · link 30</span>
        <IconBtn active>
          <Glyph name="fit" />
        </IconBtn>
        <IconBtn>
          <Glyph name="settings" />
        </IconBtn>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          position: "relative",
          overflow: "hidden",
          backgroundImage: `radial-gradient(circle, ${C.borderDefault} 1px, transparent 1.2px)`,
          backgroundSize: "16px 16px",
        }}
      >
        <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
          {GRAPH_EDGES.map(([a, b]) => (
            <line key={`${a}-${b}`} x1={byId[a].x} y1={byId[a].y} x2={byId[b].x} y2={byId[b].y} stroke={C.borderStrong} strokeWidth={1} strokeDasharray="4 4" />
          ))}
        </svg>

        {GRAPH_NODES.map((n) => {
          const size = nodeSize(n.degree);
          const { color, icon } = NODE_STYLE[n.type];
          return (
            <div key={n.id} style={{ position: "absolute", left: n.x - size / 2, top: n.y - size / 2, width: size, height: size }}>
              <div
                style={{
                  width: size,
                  height: size,
                  borderRadius: "50%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: `2px solid ${color}`,
                  background: C.surfaceCard,
                }}
              >
                <Glyph name={icon} size={Math.round(size * 0.44)} color={color} strokeWidth={1.75} />
              </div>
              <span
                style={{
                  position: "absolute",
                  top: "calc(100% + 3px)",
                  left: "50%",
                  transform: "translateX(-50%)",
                  width: 145,
                  textAlign: "center",
                  fontSize: 12,
                  lineHeight: "14px",
                  color: C.textSecondary,
                }}
              >
                {n.label}
              </span>
            </div>
          );
        })}

        <div
          style={{
            position: "absolute",
            left: 12,
            bottom: 12,
            display: "flex",
            flexDirection: "column",
            borderRadius: 4,
            border: hairline,
            background: C.surfaceCard,
            overflow: "hidden",
          }}
        >
          {(["plus", "minus"] as const).map((z, i) => (
            <span key={z} style={{ width: 24, height: 22, display: "flex", alignItems: "center", justifyContent: "center", borderTop: i ? hairline : "none" }}>
              {z === "plus" ? <Glyph name="plus" size={13} /> : <span style={{ width: 9, height: 1.5, borderRadius: 1, background: C.textSecondary }} />}
            </span>
          ))}
        </div>
      </div>

      <div style={{ height: 22, flexShrink: 0, display: "flex", alignItems: "center", gap: 10, padding: "0 10px", borderTop: hairline }}>
        {LEGEND.map(([label, color]) => (
          <span key={label} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", border: `2px solid ${color}` }} />
            <span style={mono(C.textTertiary)}>{label}</span>
          </span>
        ))}
        <Spacer />
        <span style={mono()}>dashed = link · dotted = reference prop · solid = embed</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

const SCREENS: Record<FeatureKey, { tabs: TabSpec[]; label: string; Screen: () => ReactNode }> = {
  chat: {
    tabs: [
      { icon: "today", label: "Today" },
      { icon: "chat", label: "Chat", active: true },
    ],
    label: "Companion's chat: Claude Code, hosted on your desktop, answers a question about a launch after searching your notes and tasks",
    Screen: ChatScreen,
  },
  notes: {
    tabs: [
      { icon: "file", label: "Launch plan — v1.2", active: true, doc: true },
      { icon: "file", label: "Launch sync — Monday", doc: true },
    ],
    label: "Companion's note editor: a launch plan that links to the tasks it tracks",
    Screen: NotesScreen,
  },
  tasks: {
    tabs: [
      { icon: "today", label: "Today" },
      { icon: "tasks", label: "Review pricing page copy", active: true, doc: true },
    ],
    label: "Companion's task list and editor: a task with a due date, a reminder and linked notes",
    Screen: TasksScreen,
  },
  habits: {
    tabs: [
      { icon: "today", label: "Today" },
      { icon: "habits", label: "Habits", active: true },
    ],
    label: "Habits in Companion: a daily habit with a 12-day streak and sixteen weeks of check-ins",
    Screen: HabitsScreen,
  },
  graph: {
    tabs: [
      { icon: "file", label: "Launch plan — v1.2", doc: true },
      { icon: "graph", label: "Graph", active: true },
    ],
    label: "Companion's graph: a project at the centre of its linked notes and tasks",
    Screen: GraphScreen,
  },
};

function AppWindow({ feature }: { feature: FeatureKey }) {
  const { tabs, Screen } = SCREENS[feature] ?? SCREENS.chat;
  return (
    <div style={{ width: W, height: H, display: "flex", flexDirection: "column", background: C.surfaceApp, fontFamily: SANS, color: C.textPrimary }}>
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <Rail active={feature} />
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <Toolbar tabs={tabs} />
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: "flex",
              margin: "0 12px 12px",
              borderRadius: 6,
              border: hairline,
              background: C.surfaceCard,
              overflow: "hidden",
            }}
          >
            <Screen />
          </div>
        </div>
      </div>
      <StatusBar tabCount={tabs.length} />
    </div>
  );
}

/** The app window at its real size, scaled down as a unit to fit narrower containers. */
export function FeatureMockups({ feature }: { feature: FeatureKey }) {
  const frame = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1, el.clientWidth / W));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={frame}
      role="img"
      aria-label={(SCREENS[feature] ?? SCREENS.chat).label}
      style={{ position: "relative", width: "100%", aspectRatio: `${W} / ${H}`, overflow: "hidden", userSelect: "none" }}
    >
      <div style={{ position: "absolute", top: 0, left: 0, transform: scale < 1 ? `scale(${scale})` : undefined, transformOrigin: "0 0" }}>
        <AppWindow feature={feature} />
      </div>
    </div>
  );
}
