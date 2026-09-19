import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { BrandMark, Icon, type IconName } from "../ds";

// In-browser product mockups shown inside the landing page's "safari window". Each one is
// the web app's desktop layout drawn at 1:1 — the 44px icon rail, the tab toolbar, the inset
// panel and the mono status strip — with each feature's screen rebuilt from the real
// components (packages/app: ChatScreen, NoteEditor, TaskEditor, CanvasView, CalendarScreen,
// GraphView). The window is laid out at a fixed 978×480 and scaled down as a whole on
// narrower screens, so it always reads like a screenshot of the app rather than a reflowed
// approximation. The pieces are exported for ProjectMockups, which crops the project view
// out of the same kit.

export type FeatureKey = "chat" | "notes" | "tasks" | "canvases" | "calendar" | "habits" | "graph";

// The app's dense-redesign values (packages/design-system: palette.ts, tokens.ts). The site's
// own ds snapshot is deliberately airier, so the mockups carry the app's numbers instead.
export const C = {
  textPrimary: "#1a1a18",
  textSecondary: "#595954",
  textTertiary: "#7b7b75",
  textQuaternary: "#a7a7a1",
  textInverse: "#ffffff",
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
  infoSoft: "#eaf1fb",
  infoActive: "#2b579e",
  avatar: "#3e3e3a",
  meeting: "#6e56cf",
};
export const SANS = "'Geist', ui-sans-serif, system-ui, sans-serif";
export const MONO = "'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace";

const W = 978;
const H = 480;

export const mono = (color = C.textQuaternary, size = 11): CSSProperties => ({
  fontFamily: MONO,
  fontSize: size,
  lineHeight: `${Math.round(size * 1.35)}px`,
  color,
  whiteSpace: "nowrap",
});
export const eyebrow: CSSProperties = { ...mono(C.textQuaternary, 10), fontWeight: 600, letterSpacing: 1.2, textTransform: "uppercase" };
export const ellipsis: CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
export const hairline = `1px solid ${C.borderSubtle}`;
export const displayTitle: CSSProperties = { fontSize: 30, fontWeight: 600, letterSpacing: "-0.75px", lineHeight: "34px", color: C.textPrimary };

export function Glyph({ name, size = 14, color = C.textSecondary, strokeWidth = 1.5 }: { name: IconName; size?: number; color?: string; strokeWidth?: number }) {
  return <Icon name={name} size={size} color={color} strokeWidth={strokeWidth} />;
}

export function IconBtn({ children, active }: { children: ReactNode; active?: boolean }) {
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

export function Badge({ label, accent }: { label: string; accent?: boolean }) {
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

export const Spacer = () => <span style={{ flex: 1 }} />;
export const VDivider = ({ height = 10 }: { height?: number }) => <span style={{ width: 1, height, flexShrink: 0, background: C.borderSubtle }} />;

// ---------------------------------------------------------------------------
// Shell: rail · tab toolbar · inset panel · status strip (AppShell + Frame).
// ---------------------------------------------------------------------------

const RAIL: { id: FeatureKey | "today"; icon: IconName }[] = [
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

/** A browse column. `menu` marks a title that is a filter dropdown (All notes ▾) rather than a
 *  plain label (a project's Notes column). */
export function ListPane({
  title,
  count,
  plus = true,
  menu = true,
  width = 260,
  input,
  children,
}: {
  title: string;
  count: string;
  plus?: boolean;
  menu?: boolean;
  width?: number;
  input?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div style={{ width, flexShrink: 0, display: "flex", flexDirection: "column", borderRight: hairline }}>
      <div style={{ height: 32, flexShrink: 0, display: "flex", alignItems: "center", gap: 6, padding: "0 6px 0 10px" }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: C.textPrimary }}>{title}</span>
        {menu ? <Glyph name="chevronDown" size={10} color={C.textTertiary} /> : null}
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

export function FieldInput({ icon, placeholder }: { icon: IconName; placeholder: string }) {
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

/** A dense 24px row. `done` is a completed task's title: struck through in quaternary ink;
 *  `dragging` is the lifted row mid-reorder. */
export function Row({
  lead,
  title,
  meta,
  metaColor,
  selected,
  done,
  dragging,
}: {
  lead: ReactNode;
  title: string;
  meta?: string;
  metaColor?: string;
  selected?: boolean;
  done?: boolean;
  dragging?: boolean;
}) {
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
        background: selected ? C.surfaceSelected : dragging ? C.surfaceActive : "transparent",
      }}
    >
      {lead}
      <span
        style={{
          ...ellipsis,
          flex: 1,
          fontSize: 13,
          fontWeight: 500,
          color: done ? C.textQuaternary : selected ? C.textAccent : C.textPrimary,
          textDecoration: done ? "line-through" : undefined,
        }}
      >
        {title}
      </span>
      {meta ? <span style={mono(metaColor)}>{meta}</span> : null}
    </div>
  );
}

export const Checkbox = ({ size = 12, border = 1, checked }: { size?: number; border?: number; checked?: boolean }) => (
  <span
    style={{
      width: size,
      height: size,
      flexShrink: 0,
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: size > 14 ? 3 : 2,
      border: `${border}px solid ${checked ? C.accent : C.borderStrong}`,
      background: checked ? C.accent : C.surfaceCard,
    }}
  >
    {checked ? <Glyph name="check" size={Math.round(size * 0.72)} strokeWidth={2.5} color={C.onAccent} /> : null}
  </span>
);

export function DocHeader({ badge, meta }: { badge: string; meta: string }) {
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
export function NoteChip({ title }: { title: string }) {
  return (
    <span style={chipBox}>
      <Glyph name="link" size={11} color={C.textQuaternary} />
      <span style={mono(C.textSecondary)}>{title}</span>
    </span>
  );
}

/** A field chip in a document's meta row (due date, reminder, cadence). */
export function FieldChip({ icon, label, clear, sans, outline }: { icon?: IconName; label: string; clear?: boolean; sans?: boolean; outline?: boolean }) {
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

export const prose: CSSProperties = { fontSize: 14, lineHeight: "24px", color: C.textPrimary, margin: 0 };

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
// Canvases — the boards list beside an open board (CanvasesScreen, CanvasPane, CanvasView):
// the name row, the 28px tool strip, the board on its 16px dotted grid, and the mono status
// strip. Cards, stickies, groups and arrows carry CanvasView's numbers: 4px cards with a 2px
// bar in their kind's colour, stickies washed at 18% inside a full-strength border, groups
// washed at 7% behind the cards with a mono label notched into the top edge, and 1.25px
// curved edges that end in a filled arrowhead.
// ---------------------------------------------------------------------------

export type Side = "top" | "right" | "bottom" | "left";
type Box = { id: string; x: number; y: number; w: number; h: number };
export type BoardNode = Box &
  (
    | { kind: "group"; label: string; color?: string }
    | { kind: "sticky"; text: string; color?: string }
    | { kind: "note"; title: string; excerpt: string }
    | { kind: "task"; title: string; meta: string; done?: boolean }
    | { kind: "event"; title: string; meta: string }
  );
export type BoardEdge = { from: string; fromSide: Side; to: string; toSide: Side; label?: string };

/** A swatch at the given alpha (CanvasView's `wash`). */
function wash(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
}

const boardCard: CSSProperties = {
  position: "absolute",
  display: "flex",
  flexDirection: "column",
  gap: 2,
  padding: "4px 7px",
  overflow: "hidden",
  borderRadius: 4,
  border: hairline,
  background: C.surfaceCard,
  fontSize: 13,
  lineHeight: "18px",
  color: C.textPrimary,
};
const cardHead: CSSProperties = { display: "flex", alignItems: "center", gap: 5, minWidth: 0, flexShrink: 0 };
const cardTitle: CSSProperties = { ...ellipsis, flex: 1, fontSize: 13, fontWeight: 500 };
const cardMeta: CSSProperties = { ...mono(), ...ellipsis, lineHeight: "14px", flexShrink: 0 };
const cardBody: CSSProperties = { fontSize: 12, lineHeight: "16px", color: C.textSecondary, overflow: "hidden" };
// The colours the graph gives these entities, as the cards' left bars.
const KIND_BAR = { note: C.success, task: C.info, event: C.textPrimary };

function BoardCard({ node }: { node: BoardNode }) {
  const box = { left: node.x, top: node.y, width: node.w, height: node.h };
  switch (node.kind) {
    case "group": {
      const color = node.color ?? "#64748b";
      return (
        <div style={{ position: "absolute", ...box, borderRadius: 6, border: `1px solid ${wash(color, 0.45)}`, background: wash(color, 0.07) }}>
          <span style={{ ...mono(C.textTertiary), position: "absolute", top: -1, left: 8, transform: "translateY(-50%)", padding: "0 4px", background: C.surfaceCard }}>
            {node.label}
          </span>
        </div>
      );
    }
    case "sticky": {
      const color = node.color ?? "#eab308";
      const tint = wash(color, 0.18);
      return (
        <div
          style={{
            ...boardCard,
            ...box,
            display: "block",
            padding: "4px 6px",
            border: `1px solid ${color}`,
            background: `linear-gradient(${tint}, ${tint}), ${C.surfaceCard}`,
            fontSize: 12,
            lineHeight: "16px",
          }}
        >
          {node.text}
        </div>
      );
    }
    case "note":
      return (
        <div style={{ ...boardCard, ...box, borderLeft: `2px solid ${KIND_BAR.note}` }}>
          <div style={cardHead}>
            <Glyph name="file" size={11} color={C.textQuaternary} />
            <span style={cardTitle}>{node.title}</span>
          </div>
          <div style={cardMeta}>note</div>
          <div style={{ ...cardBody, flex: 1, minHeight: 0 }}>{node.excerpt}</div>
        </div>
      );
    case "task":
      return (
        <div style={{ ...boardCard, ...box, flexDirection: "row", alignItems: "flex-start", gap: 6, borderLeft: `2px solid ${KIND_BAR.task}` }}>
          <span style={{ display: "flex", marginTop: 3 }}>
            <Checkbox checked={node.done} />
          </span>
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ ...cardTitle, flex: "none", color: node.done ? C.textTertiary : C.textPrimary, textDecoration: node.done ? "line-through" : undefined }}>
              {node.title}
            </span>
            <span style={cardMeta}>{node.meta}</span>
          </div>
        </div>
      );
    case "event":
      return (
        <div style={{ ...boardCard, ...box, borderLeft: `2px solid ${KIND_BAR.event}` }}>
          <div style={cardHead}>
            <Glyph name="calendar" size={11} color={C.textQuaternary} />
            <span style={cardTitle}>{node.title}</span>
          </div>
          <div style={cardMeta}>{node.meta}</div>
        </div>
      );
  }
}

const OUTWARD: Record<Side, [number, number]> = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };

/** Where an edge meets a card: the middle of that side, where its handle sits. */
function anchor(n: Box, side: Side): [number, number] {
  if (side === "top") return [n.x + n.w / 2, n.y];
  if (side === "bottom") return [n.x + n.w / 2, n.y + n.h];
  if (side === "left") return [n.x, n.y + n.h / 2];
  return [n.x + n.w, n.y + n.h / 2];
}

/** React Flow's bezier control point for a handle on `side` (getBezierPath, curvature 0.3). */
function control(side: Side, [x1, y1]: [number, number], [x2, y2]: [number, number]): [number, number] {
  const offset = (d: number) => (d >= 0 ? 0.5 * d : 0.3 * 25 * Math.sqrt(-d));
  if (side === "left") return [x1 - offset(x1 - x2), y1];
  if (side === "right") return [x1 + offset(x2 - x1), y1];
  if (side === "top") return [x1, y1 - offset(y1 - y2)];
  return [x1, y1 + offset(y2 - y1)];
}

function edgeGeometry(edge: BoardEdge, byId: Record<string, Box>) {
  const s = anchor(byId[edge.from], edge.fromSide);
  const tip = anchor(byId[edge.to], edge.toSide);
  const [ox, oy] = OUTWARD[edge.toSide];
  // The line stops 7px short of the target, so the filled arrowhead covers the join.
  const t: [number, number] = [tip[0] + ox * 7, tip[1] + oy * 7];
  const c1 = control(edge.fromSide, s, t);
  const c2 = control(edge.toSide, t, s);
  // The label rides the curve's midpoint.
  const mid = (i: 0 | 1) => s[i] * 0.125 + c1[i] * 0.375 + c2[i] * 0.375 + t[i] * 0.125;
  return {
    d: `M${s[0]},${s[1]} C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${t[0]},${t[1]}`,
    tip,
    angle: (Math.atan2(-oy, -ox) * 180) / Math.PI,
    label: [mid(0), mid(1)],
  };
}

/** A board at 1:1: groups behind, edges under the cards, edge labels on top. */
export function CanvasBoard({ nodes, edges }: { nodes: BoardNode[]; edges: BoardEdge[] }) {
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const lines = edges.map((edge) => ({ edge, key: `${edge.from}-${edge.to}`, ...edgeGeometry(edge, byId) }));
  return (
    <div
      style={{
        position: "relative",
        flex: 1,
        minHeight: 0,
        overflow: "hidden",
        backgroundImage: `radial-gradient(circle, ${C.borderDefault} 1px, transparent 1.2px)`,
        backgroundSize: "16px 16px",
      }}
    >
      {nodes
        .filter((n) => n.kind === "group")
        .map((n) => (
          <BoardCard key={n.id} node={n} />
        ))}
      <svg style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", overflow: "visible" }}>
        {lines.map((l) => (
          <g key={l.key}>
            <path d={l.d} fill="none" stroke={C.borderStrong} strokeWidth={1.25} strokeLinecap="round" />
            <path
              d="M 0 0 L -8 -4 L -6 0 L -8 4 Z"
              transform={`translate(${l.tip[0]} ${l.tip[1]}) rotate(${l.angle})`}
              fill={C.borderStrong}
              stroke={C.borderStrong}
              strokeWidth={1}
              strokeLinejoin="round"
            />
          </g>
        ))}
      </svg>
      {nodes
        .filter((n) => n.kind !== "group")
        .map((n) => (
          <BoardCard key={n.id} node={n} />
        ))}
      {lines.map((l) =>
        l.edge.label ? (
          <span
            key={l.key}
            style={{
              position: "absolute",
              left: l.label[0],
              top: l.label[1],
              transform: "translate(-50%, -50%)",
              padding: "0 5px",
              borderRadius: 3,
              border: hairline,
              background: C.surfaceCard,
              fontSize: 11,
              lineHeight: "14px",
              color: C.textSecondary,
              whiteSpace: "nowrap",
            }}
          >
            {l.edge.label}
          </span>
        ) : null,
      )}
    </div>
  );
}

/** A board's name row: its name edited in place, then projects and delete. */
export function CanvasPaneHeader({ name }: { name: string }) {
  return (
    <div style={{ height: 28, flexShrink: 0, display: "flex", alignItems: "center", gap: 6, padding: "0 6px 0 10px", borderBottom: hairline }}>
      <Glyph name="canvas" size={12} color={C.textQuaternary} />
      <span style={{ ...ellipsis, flex: 1, fontSize: 13, fontWeight: 600, color: C.textPrimary }}>{name}</span>
      <IconBtn>
        <Glyph name="folder" size={13} />
      </IconBtn>
      <IconBtn>
        <Glyph name="trash" size={13} />
      </IconBtn>
    </div>
  );
}

const ToolDivider = () => <span style={{ width: 1, height: 14, flexShrink: 0, margin: "0 4px", background: C.borderSubtle }} />;
const monoButton: CSSProperties = { ...mono(C.textSecondary, 12), width: 22, flexShrink: 0, textAlign: "center" };
// The strip's quick swatches: amber, teal, violet, indigo, slate.
const QUICK_SWATCHES = ["#f59e0b", "#14b8a6", "#8b5cf6", "#6366f1", "#64748b"];

/** The board's tool strip with nothing selected, so connect, redo and the swatches rest
 *  disabled. */
export function CanvasToolStrip() {
  const add: IconName[] = ["sticky", "group", "file", "tasks", "calendar", "image", "link"];
  const off: CSSProperties = { display: "flex", opacity: 0.35 };
  return (
    <div style={{ height: 28, flexShrink: 0, display: "flex", alignItems: "center", gap: 2, padding: "0 6px", borderBottom: hairline }}>
      {add.map((name) => (
        <IconBtn key={name}>
          <Glyph name={name} size={13} />
        </IconBtn>
      ))}
      <span style={off}>
        <IconBtn>
          <Glyph name="arrow" size={13} />
        </IconBtn>
      </span>
      <ToolDivider />
      <IconBtn>
        <Glyph name="undo" size={13} />
      </IconBtn>
      <span style={off}>
        <IconBtn>
          <Glyph name="redo" size={13} />
        </IconBtn>
      </span>
      <ToolDivider />
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "0 2px", opacity: 0.4 }}>
        {QUICK_SWATCHES.map((c) => (
          <span key={c} style={{ width: 11, height: 11, flexShrink: 0, borderRadius: 2, background: c }} />
        ))}
      </span>
      <Spacer />
      <span style={monoButton}>−</span>
      <span style={{ ...mono(), width: 34, flexShrink: 0, textAlign: "center" }}>100%</span>
      <span style={monoButton}>+</span>
      <IconBtn>
        <Glyph name="fit" size={13} />
      </IconBtn>
      <ToolDivider />
      <IconBtn>
        <Glyph name="search" size={13} />
      </IconBtn>
      <span style={monoButton}>?</span>
    </div>
  );
}

function CanvasStatus({ nodes, edges }: { nodes: number; edges: number }) {
  return (
    <div style={{ height: 22, flexShrink: 0, display: "flex", alignItems: "center", gap: 8, padding: "0 10px", borderTop: hairline, background: C.surfaceApp }}>
      <span style={{ ...mono(), ...ellipsis }}>double-click the board for a sticky · drag from a card’s edge to connect</span>
      <Spacer />
      <span style={{ ...mono(), flexShrink: 0 }}>
        {nodes} nodes · {edges} edges
      </span>
    </div>
  );
}

const CANVASES = [
  { title: "Launch map", when: "2m ago" },
  { title: "Pricing page flow", when: "yesterday" },
  { title: "Offsite brainstorm", when: "4d ago" },
];

// Board space: the open board is 687×330 in this window.
const LAUNCH_MAP: BoardNode[] = [
  { id: "before", kind: "group", label: "Before launch", x: 268, y: 26, w: 232, h: 128 },
  {
    id: "positioning",
    kind: "note",
    title: "Pricing page positioning",
    excerpt: "Lead with self-hosting. The annual toggle defaults to yearly.",
    x: 24,
    y: 40,
    w: 200,
    h: 88,
  },
  { id: "review", kind: "task", title: "Review pricing page copy", meta: "task · due sep 19", x: 282, y: 44, w: 204, h: 42 },
  { id: "draft", kind: "task", title: "Draft the launch announcement", meta: "task · due sep 18", x: 282, y: 96, w: 204, h: 42 },
  { id: "launch", kind: "event", title: "Launch day", meta: "event · thu, sep 24 · all day", x: 448, y: 214, w: 216, h: 44 },
  { id: "faq", kind: "sticky", text: "Ship the FAQ before the pricing page?", color: "#f59e0b", x: 24, y: 176, w: 176, h: 52 },
  { id: "changelog", kind: "sticky", text: "Changelog first, then the newsletter.", color: "#8b5cf6", x: 540, y: 40, w: 124, h: 70 },
];
const LAUNCH_EDGES: BoardEdge[] = [
  { from: "positioning", fromSide: "right", to: "review", toSide: "left" },
  { from: "draft", fromSide: "right", to: "launch", toSide: "top", label: "by thu" },
  { from: "faq", fromSide: "right", to: "launch", toSide: "left" },
];

function CanvasesScreen() {
  return (
    <>
      <ListPane title="All canvases" count={String(CANVASES.length)} width={220} input={<FieldInput icon="search" placeholder="Search canvases" />}>
        {CANVASES.map((c, i) => (
          <Row key={c.title} selected={i === 0} lead={<Glyph name="canvas" size={12} color={i === 0 ? C.textAccent : C.textQuaternary} />} title={c.title} meta={c.when} />
        ))}
      </ListPane>

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <CanvasPaneHeader name="Launch map" />
        <CanvasToolStrip />
        <CanvasBoard nodes={LAUNCH_MAP} edges={LAUNCH_EDGES} />
        <CanvasStatus nodes={LAUNCH_MAP.length} edges={LAUNCH_EDGES.length} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Calendar — the week grid (CalendarScreen): the month toolbar and its legend, the day
// header, the all-day band, and 34px hour rows scrolled to the working day. Events are ink
// blocks barred in their calendar's colour, a task sits on its due time in blue, and a dated
// note is a green-barred chip in the all-day band. Today's column is tinted, with the now
// line across it.
// ---------------------------------------------------------------------------

export type CalKind = "event" | "task" | "note";
/** One item in the week. `day` indexes the week (0 is Sunday) and times are minutes since
 *  midnight; an item without a start sits in the all-day band. */
export type CalItem = { day: number; kind: CalKind; title: string; start?: number; end?: number; color?: string };
export type WeekDay = { name: string; date: number };

const ROW_H = 34;
const GUTTER = 40;
const DAY_HOURS = Array.from({ length: 24 }, (_, h) => h);
const CAL_KIND: Record<CalKind, { bg: string; fg: string; bar: string }> = {
  event: { bg: C.textPrimary, fg: C.textInverse, bar: C.textTertiary },
  task: { bg: C.infoSoft, fg: C.infoActive, bar: C.info },
  note: { bg: C.surfaceApp, fg: C.textSecondary, bar: C.success },
};

const pad2 = (n: number) => String(n).padStart(2, "0");
const hourLabel = (h: number) => (h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`);

function CalendarToolbar({ month, week }: { month: string; week: string }) {
  const legend: [string, string][] = [
    ["events", C.textPrimary],
    ["tasks", C.info],
    ["notes", C.success],
  ];
  return (
    <div style={{ height: 32, flexShrink: 0, display: "flex", alignItems: "center", gap: 8, padding: "0 10px", borderBottom: hairline }}>
      <Glyph name="calendar" size={14} />
      <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-0.18px", lineHeight: "20px", color: C.textPrimary, whiteSpace: "nowrap" }}>{month}</span>
      <span style={{ display: "flex", gap: 1 }}>
        <IconBtn>
          <Glyph name="chevronLeft" size={14} />
        </IconBtn>
        <IconBtn>
          <Glyph name="chevronRight" size={14} />
        </IconBtn>
      </span>
      <span style={mono()}>{week}</span>
      <VDivider height={14} />
      <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {legend.map(([label, color]) => (
          <span key={label} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 7, height: 7, borderRadius: 3, background: color }} />
            <span style={mono(C.textTertiary)}>{label}</span>
          </span>
        ))}
      </span>
      <Spacer />
      <IconBtn>
        <Glyph name="refresh" size={13} />
      </IconBtn>
      <span style={{ height: 22, flexShrink: 0, display: "inline-flex", alignItems: "center", padding: "0 8px", borderRadius: 4, background: C.surfaceSunken, fontSize: 12, fontWeight: 500, color: C.textPrimary }}>
        Today
      </span>
      <IconBtn>
        <Glyph name="plus" size={14} />
      </IconBtn>
    </div>
  );
}

/** A timed item in its day column. Short blocks run the title and time on one line. */
function TimedBlock({ item }: { item: CalItem }) {
  const start = item.start ?? 0;
  const end = item.end ?? start + 60; // no end reads as an hour, as in the app
  const height = Math.max(ROW_H / 2, ((end - start) / 60) * ROW_H);
  const tight = height < 26;
  const k = CAL_KIND[item.kind];
  return (
    <div style={{ position: "absolute", left: 0, right: 0, top: (start / 60) * ROW_H + 1, height: height - 2, padding: "0 2px" }}>
      <div
        style={{
          height: "100%",
          overflow: "hidden",
          display: "flex",
          flexDirection: tight ? "row" : "column",
          alignItems: tight ? "center" : "stretch",
          gap: tight ? 4 : 0,
          padding: tight ? "0 4px" : "2px 4px",
          borderLeft: `2px solid ${item.color ?? k.bar}`,
          borderRadius: 3,
          background: k.bg,
          color: k.fg,
        }}
      >
        <span style={{ ...ellipsis, flex: tight ? 1 : undefined, fontSize: 12, lineHeight: "16px", fontWeight: 600 }}>{item.title}</span>
        <span style={{ fontFamily: MONO, fontSize: 9, lineHeight: "12px", opacity: 0.75, flexShrink: 0 }}>
          {pad2(Math.floor(start / 60))}:{pad2(start % 60)}
        </span>
      </div>
    </div>
  );
}

/** The week grid under its toolbar. `scrollTop` is how far the 24-hour grid is scrolled;
 *  `colWidth` fixes the day columns for a cropped view (they share the width otherwise). */
export function WeekView({
  month,
  week,
  days,
  items,
  scrollTop,
  today,
  now,
  colWidth,
}: {
  month: string;
  week: string;
  days: WeekDay[];
  items: CalItem[];
  scrollTop: number;
  /** Today's index in `days`, when the week holds it. */
  today?: number;
  /** Minutes since midnight, for the now line. */
  now?: number;
  colWidth?: number;
}) {
  const col: CSSProperties = colWidth ? { width: colWidth, flexShrink: 0 } : { flex: 1, minWidth: 0 };
  const allDay = items.filter((it) => it.start == null);
  const timed = items.filter((it) => it.start != null);
  const tint = (i: number) => (i === today ? C.accentSoft : undefined);
  return (
    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
      <CalendarToolbar month={month} week={week} />

      <div style={{ flexShrink: 0, display: "flex", borderBottom: hairline }}>
        <span style={{ width: GUTTER, flexShrink: 0 }} />
        {days.map((d, i) => (
          <div key={d.date} style={{ ...col, display: "flex", flexDirection: "column", alignItems: "center", gap: 1, padding: "4px 0 5px", borderLeft: hairline }}>
            <span style={{ ...mono(i === today ? C.textAccent : C.textQuaternary, 10), letterSpacing: 0.66, textTransform: "uppercase" }}>{d.name}</span>
            <span
              style={{
                minWidth: 20,
                height: 20,
                padding: "0 4px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 999,
                background: i === today ? C.accent : "transparent",
                fontSize: 13,
                fontWeight: 500,
                color: i === today ? C.onAccent : C.textPrimary,
              }}
            >
              {d.date}
            </span>
          </div>
        ))}
      </div>

      {allDay.length ? (
        <div style={{ flexShrink: 0, display: "flex", borderBottom: hairline }}>
          <div style={{ width: GUTTER, flexShrink: 0, display: "flex", justifyContent: "flex-end", padding: "7px 2px 0 0" }}>
            <span style={mono(C.textQuaternary, 9)}>all-day</span>
          </div>
          {days.map((d, i) => (
            <div key={d.date} style={{ ...col, minHeight: 26, display: "flex", flexDirection: "column", gap: 2, padding: "4px 3px", borderLeft: hairline, background: tint(i) }}>
              {allDay
                .filter((it) => it.day === i)
                .map((it) => (
                  <span
                    key={it.title}
                    style={{ height: 18, display: "flex", alignItems: "center", padding: "0 5px", borderLeft: `2px solid ${it.color ?? CAL_KIND[it.kind].bar}`, borderRadius: 3, background: C.surfaceApp }}
                  >
                    <span style={{ ...ellipsis, fontSize: 12, fontWeight: 500, color: C.textSecondary }}>{it.title}</span>
                  </span>
                ))}
            </div>
          ))}
        </div>
      ) : null}

      <div style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: -scrollTop, left: 0, right: colWidth ? undefined : 0, display: "flex" }}>
          <div style={{ width: GUTTER, flexShrink: 0 }}>
            {DAY_HOURS.map((h) => (
              <div key={h} style={{ height: ROW_H }}>
                <div style={{ ...mono(C.textQuaternary, 10), position: "relative", top: -5, paddingRight: 6, textAlign: "right" }}>{hourLabel(h)}</div>
              </div>
            ))}
          </div>
          {days.map((d, i) => (
            <div key={d.date} style={{ ...col, position: "relative", borderLeft: hairline, background: tint(i) }}>
              {DAY_HOURS.map((h) => (
                <div key={h} style={{ height: ROW_H, borderBottom: hairline }} />
              ))}
              {timed
                .filter((it) => it.day === i)
                .map((it) => (
                  <TimedBlock key={it.title} item={it} />
                ))}
              {i === today && now != null ? (
                <div style={{ position: "absolute", left: 0, right: 0, top: (now / 60) * ROW_H, borderTop: `2px solid ${C.accent}`, zIndex: 5 }}>
                  <span style={{ position: "absolute", left: -3, top: -4, width: 7, height: 7, borderRadius: "50%", background: C.accent }} />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const hm = (h: number, m = 0) => h * 60 + m;
const WORK = "#6366f1";
const PERSONAL = "#ec4899";

// The launch week: today is Friday the 18th, a little before three.
const W38: WeekDay[] = [
  { name: "Sun", date: 13 },
  { name: "Mon", date: 14 },
  { name: "Tue", date: 15 },
  { name: "Wed", date: 16 },
  { name: "Thu", date: 17 },
  { name: "Fri", date: 18 },
  { name: "Sat", date: 19 },
];
const LAUNCH_WEEK: CalItem[] = [
  { day: 1, kind: "event", title: "Sprint 38", color: WORK },
  { day: 5, kind: "note", title: "September 18, 2026" },
  { day: 1, kind: "task", title: "Weekly team sync", start: hm(9) },
  { day: 1, kind: "event", title: "Launch sync", start: hm(10), end: hm(11), color: WORK },
  { day: 2, kind: "event", title: "Design review", start: hm(14), end: hm(15), color: WORK },
  { day: 3, kind: "event", title: "1:1 with Priya", start: hm(11), end: hm(11, 30), color: WORK },
  { day: 3, kind: "event", title: "Dentist", start: hm(16), end: hm(17), color: PERSONAL },
  { day: 4, kind: "event", title: "Pricing workshop", start: hm(13), end: hm(14, 30), color: WORK },
  { day: 5, kind: "event", title: "Lunch with Sam", start: hm(12, 30), end: hm(13, 30), color: PERSONAL },
  { day: 5, kind: "task", title: "Draft the launch announcement", start: hm(16) },
  { day: 6, kind: "event", title: "Farmers market", start: hm(10), end: hm(11), color: PERSONAL },
  { day: 6, kind: "task", title: "Review pricing page copy", start: hm(15) },
];

function CalendarScreen() {
  return <WeekView month="September 2026" week="w38" days={W38} items={LAUNCH_WEEK} today={5} now={hm(14, 40)} scrollTop={9 * ROW_H - 8} />;
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

/** A fixed, plausible check-in history: mostly done, the odd miss, then the current run of
 *  `streak` days. `seed` varies the older pattern between habits. */
function checkedIn(i: number, streak: number, seed: number): boolean | null {
  if (i > TODAY) return null;
  if (i > TODAY - streak) return true;
  if (i === TODAY - streak) return false;
  return (i * seed + 11) % 10 < 7;
}

export function RoundCheck({ done, size = 12 }: { done: boolean; size?: number }) {
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

export function StreakGrid({ streak = STREAK, seed = 37 }: { streak?: number; seed?: number }) {
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
            const state = checkedIn(i, streak, seed);
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
  canvases: {
    tabs: [
      { icon: "today", label: "Today" },
      { icon: "canvas", label: "Launch map", active: true },
    ],
    label: "Companion's canvases: a launch board where a note, two tasks, an event and sticky notes are grouped and joined by arrows",
    Screen: CanvasesScreen,
  },
  calendar: {
    tabs: [
      { icon: "today", label: "Today" },
      { icon: "calendar", label: "Calendar", active: true },
    ],
    label: "Companion's calendar: a week of events from a work and a personal calendar, beside due tasks and a daily note",
    Screen: CalendarScreen,
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
