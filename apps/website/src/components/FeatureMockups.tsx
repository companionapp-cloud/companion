import {
  Badge,
  BrandMark,
  Button,
  Icon,
  ProgressRing,
  colors,
  radius,
  space,
  type IconName,
} from "@companion/design-system";
import type { CSSProperties, ReactNode } from "react";

// In-browser product mockups shown inside the landing page's "safari window". These mirror
// the actual Companion desktop UI (packages/app): a hover-reveal icon rail on the left and a
// toolbar-framed content card, with each feature's screen recreated from the real components
// (chat bubbles + tool "action lines", the daily/notes editor with linked mentions, the task
// list, habit streaks, and the force-directed knowledge graph).

export type FeatureKey = "chat" | "notes" | "tasks" | "habits" | "graph";

// ---------------------------------------------------------------------------
// App chrome: the left rail + the framed content card, matching AppShell.
// ---------------------------------------------------------------------------

const RAIL: { view: FeatureKey | "today"; icon: IconName; label: string }[] = [
  { view: "today", icon: "today", label: "Today" },
  { view: "chat", icon: "chat", label: "Ask AI" },
  { view: "notes", icon: "notes", label: "Notes" },
  { view: "tasks", icon: "tasks", label: "Tasks" },
  { view: "habits", icon: "habits", label: "Habits" },
  { view: "graph", icon: "graph", label: "Graph" },
];

function AppChrome({ active, title, children }: { active: FeatureKey; title: ReactNode; children: ReactNode }) {
  return (
    <div style={{ height: "100%", display: "flex", background: colors.surfaceApp, fontFamily: "'Geist', sans-serif" }}>
      {/* rail */}
      <div style={{ width: 56, flexShrink: 0, padding: `${space.md}px ${space.md}px`, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
        <div style={{ height: 40, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: space.md }}>
          <BrandMark size={24} />
        </div>
        {RAIL.map((item) => {
          const on = item.view === active;
          return (
            <div
              key={item.view}
              title={item.label}
              style={{
                width: 40,
                height: 40,
                borderRadius: radius.md,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: on ? colors.accentSoft : "transparent",
              }}
            >
              <Icon name={item.icon} size={19} color={on ? colors.accentHover : colors.textSecondary} />
            </div>
          );
        })}
        <div style={{ flex: 1 }} />
        <div style={{ width: 40, height: 40, borderRadius: radius.md, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Icon name="settings" size={18} color={colors.textSecondary} />
        </div>
      </div>

      {/* framed content */}
      <div style={{ flex: 1, minWidth: 0, padding: `${space.md}px ${space.md}px ${space.md}px 0` }}>
        <div
          style={{
            height: "100%",
            display: "flex",
            flexDirection: "column",
            background: colors.surfaceCard,
            border: `1px solid ${colors.borderSubtle}`,
            borderRadius: radius.lg,
            overflow: "hidden",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: space.md, height: 44, paddingLeft: space.md, paddingRight: space.lg, borderBottom: `1px solid ${colors.borderSubtle}`, flexShrink: 0 }}>
            <Icon name="chevronLeft" size={17} color={colors.textTertiary} />
            <Icon name="chevronRight" size={17} color={colors.borderStrong} />
            <span style={{ fontFamily: "'Geist Mono', monospace", fontSize: 12.5, color: colors.textTertiary, flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {title}
            </span>
          </div>
          <div style={{ flex: 1, minHeight: 0, display: "flex" }}>{children}</div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat — list column + conversation with tool action lines + composer.
// ---------------------------------------------------------------------------

function Bubble({ me, children }: { me?: boolean; children: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: me ? "flex-end" : "flex-start" }}>
      <div
        style={{
          maxWidth: "84%",
          padding: `${space.md}px ${space.lg}px`,
          borderRadius: radius.lg,
          fontSize: 14.5,
          lineHeight: 1.5,
          color: colors.textPrimary,
          background: me ? colors.accentSoft : colors.surfaceSunken,
          border: `1px solid ${me ? colors.accentSoftBorder : colors.borderSubtle}`,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function ActionLine({ label }: { label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: space.sm, paddingLeft: space.xs }}>
      <Icon name="check" size={13} color={colors.success} />
      <span style={{ fontFamily: "'Geist Mono', monospace", fontSize: 12.5, color: colors.textTertiary }}>{label}</span>
    </div>
  );
}

function Chat() {
  const chats = ["Launch plan", "Reading list", "Trip to Lisbon"];
  return (
    <>
      <div style={{ width: 190, flexShrink: 0, borderRight: `1px solid ${colors.borderSubtle}`, display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", padding: `${space.md}px ${space.lg}px`, borderBottom: `1px solid ${colors.borderSubtle}` }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: colors.textSecondary, flex: 1 }}>Chats</span>
          <Icon name="plus" size={15} color={colors.textTertiary} />
        </div>
        <div style={{ padding: space.sm, display: "flex", flexDirection: "column", gap: 2 }}>
          {chats.map((c, i) => (
            <div
              key={c}
              style={{
                padding: `${space.md}px ${space.lg}px`,
                borderRadius: radius.md,
                fontSize: 13,
                color: colors.textPrimary,
                background: i === 0 ? colors.surfaceSunken : "transparent",
              }}
            >
              {c}
            </div>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: space.lg, padding: space.xxl }}>
          <Bubble me>Help me plan the week around Thursday's launch.</Bubble>
          <ActionLine label="searched your notes" />
          <ActionLine label="created 3 tasks" />
          <Bubble>
            Here's a plan. I turned it into three tasks and blocked focus time on Wednesday — see{" "}
            <span style={{ color: colors.textAccent, fontWeight: 500, textDecoration: "underline", textDecorationColor: colors.accentSoftBorder }}>
              Launch checklist
            </span>
            .
          </Bubble>
        </div>
        <div style={{ padding: space.lg, borderTop: `1px solid ${colors.borderSubtle}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
            <div style={{ flex: 1, height: 40, display: "flex", alignItems: "center", padding: `0 ${space.lg}px`, background: colors.surfaceApp, border: `1px solid ${colors.borderSubtle}`, borderRadius: radius.lg, color: colors.textTertiary, fontSize: 14 }}>
              Message your assistant…
            </div>
            <Button variant="primary" size="md" label="Send" />
          </div>
          <div style={{ display: "flex", justifyContent: "center", marginTop: space.sm }}>
            <span style={{ fontFamily: "'Geist Mono', monospace", fontSize: 11.5, color: colors.textTertiary }}>claude-sonnet-4 · Anthropic ›</span>
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Notes — the note editor with a "Linked mentions" panel.
// ---------------------------------------------------------------------------

function Notes() {
  const mentions = [
    { title: "Forgetting curve", meta: "3 mentions" },
    { title: "Active recall", meta: "5 mentions" },
    { title: "Interleaving", meta: "2 mentions" },
  ];
  return (
    <>
      <div style={{ flex: 1.5, minWidth: 0, display: "flex", flexDirection: "column", padding: `${space.xxl}px ${space.xxxl}px`, gap: space.md }}>
        <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em", color: colors.textPrimary }}>Spaced repetition</div>
        <span style={{ fontFamily: "'Geist Mono', monospace", fontSize: 12, color: colors.textTertiary }}>Note · edited just now</span>
        <p style={{ fontSize: 15, lineHeight: 1.7, color: colors.textSecondary, margin: `${space.md}px 0 0` }}>
          Reviewing material at increasing intervals fights the forgetting curve. Companion links every note you write,
          so revisiting one idea surfaces the others it depends on.
        </p>
        <p style={{ fontSize: 15, lineHeight: 1.7, color: colors.textSecondary, margin: 0 }}>
          Pairs well with{" "}
          <span style={{ color: colors.textAccent, fontWeight: 500, textDecoration: "underline", textDecorationColor: colors.accentSoftBorder }}>
            active recall
          </span>{" "}
          — testing yourself rather than rereading.
        </p>
        <div style={{ display: "flex", gap: space.sm, flexWrap: "wrap", marginTop: space.sm }}>
          <Badge label="#learning" tone="neutral" />
          <Badge label="#memory" tone="neutral" />
          <Badge label="#study" tone="neutral" />
        </div>
      </div>

      <div style={{ width: 240, flexShrink: 0, borderLeft: `1px solid ${colors.borderSubtle}`, background: colors.surfaceApp, padding: space.lg, display: "flex", flexDirection: "column", gap: space.xs }}>
        <div style={{ display: "flex", alignItems: "center", gap: space.sm, padding: `${space.xs}px ${space.sm}px` }}>
          <Icon name="link" size={14} color={colors.textTertiary} />
          <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: colors.textTertiary }}>Linked mentions</span>
        </div>
        {mentions.map((m) => (
          <div key={m.title} style={{ display: "flex", alignItems: "center", gap: space.md, padding: `${space.md}px ${space.sm}px`, borderRadius: radius.md, background: colors.surfaceCard, border: `1px solid ${colors.borderSubtle}` }}>
            <Icon name="file" size={16} color={colors.textSecondary} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 500, color: colors.textPrimary }}>{m.title}</div>
              <div style={{ fontSize: 12, color: colors.textTertiary }}>{m.meta}</div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Tasks — the workspace task list.
// ---------------------------------------------------------------------------

function TaskRow({ label, tag, done }: { label: string; tag: string; done?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: space.lg, padding: `${space.md}px ${space.lg}px`, borderRadius: radius.lg, background: colors.surfaceCard, border: `1px solid ${colors.borderSubtle}` }}>
      <div
        style={{
          width: 20,
          height: 20,
          borderRadius: radius.full,
          flexShrink: 0,
          border: `1.5px solid ${done ? colors.accent : colors.borderDefault}`,
          background: done ? colors.accent : "transparent",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {done ? <Icon name="check" size={12} color={colors.onAccent} /> : null}
      </div>
      <span style={{ flex: 1, fontSize: 14.5, color: done ? colors.textTertiary : colors.textPrimary, textDecoration: done ? "line-through" : "none" }}>{label}</span>
      <Badge label={tag} tone="neutral" />
    </div>
  );
}

function Tasks() {
  return (
    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: space.sm, padding: space.xxl, overflow: "hidden" }}>
      <span style={{ fontFamily: "'Geist Mono', monospace", fontSize: 12, letterSpacing: "0.04em", textTransform: "uppercase", color: colors.textTertiary, marginBottom: space.xs }}>
        Today · Friday, July 12
      </span>
      <TaskRow label="Review pull requests" tag="Work" done />
      <TaskRow label="Outline Q3 roadmap" tag="Work" />
      <TaskRow label="Book flights for the offsite" tag="Travel" />
      <TaskRow label="30-minute walk" tag="Health" />
      <TaskRow label="Call Mom" tag="Personal" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Habits — weekly streaks.
// ---------------------------------------------------------------------------

function Habits() {
  const days = ["M", "T", "W", "T", "F", "S", "S"];
  const habits = [
    { name: "Read 20 pages", streak: 12, week: [true, true, true, false, true, false, false] },
    { name: "Move 30 min", streak: 4, week: [true, true, false, false, false, false, false] },
    { name: "Meditate", streak: 7, week: [true, false, true, true, false, false, false] },
  ];
  const filled = habits.reduce((n, h) => n + h.week.filter(Boolean).length, 0);
  const total = habits.length * 7;
  return (
    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: space.xl, padding: space.xxl, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: space.xxl, padding: space.xl, background: colors.surfaceCard, borderRadius: radius.xl, border: `1px solid ${colors.borderSubtle}` }}>
        <ProgressRing value={filled / total} size={64} stroke={8} color={colors.accent} track={colors.surfaceSunken} />
        <div>
          <div style={{ fontSize: 20, fontWeight: 600, color: colors.textPrimary }}>{Math.round((filled / total) * 100)}%</div>
          <div style={{ fontSize: 14, color: colors.textSecondary }}>completed this week · keep the streak going</div>
        </div>
      </div>
      {habits.map((h) => (
        <div key={h.name} style={{ display: "flex", alignItems: "center", gap: space.lg, padding: `${space.lg}px ${space.xl}px`, background: colors.surfaceCard, borderRadius: radius.lg, border: `1px solid ${colors.borderSubtle}`, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 130 }}>
            <div style={{ fontSize: 14.5, fontWeight: 550, color: colors.textPrimary }}>{h.name}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 2 }}>
              <Icon name="habits" size={13} color={colors.accent} />
              <span style={{ fontSize: 12.5, color: colors.textAccent }}>{h.streak} day streak</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: space.sm }}>
            {days.map((d, i) => {
              const on = h.week[i];
              return (
                <div
                  key={i}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: radius.full,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 12,
                    fontWeight: 600,
                    background: on ? colors.accent : colors.surfaceSunken,
                    color: on ? colors.onAccent : colors.textTertiary,
                  }}
                >
                  {d}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Graph — the force-directed knowledge graph (circular nodes + dashed edges).
// ---------------------------------------------------------------------------

type GraphNode = { id: string; x: number; y: number; label: string; type: "note" | "task" | "project"; size: number; focus?: boolean };

const GRAPH_NODES: GraphNode[] = [
  { id: "hub", x: 50, y: 50, label: "Learning", type: "project", size: 56, focus: true },
  { id: "spaced", x: 29, y: 27, label: "Spaced repetition", type: "note", size: 44 },
  { id: "recall", x: 70, y: 24, label: "Active recall", type: "note", size: 40 },
  { id: "forget", x: 76, y: 63, label: "Forgetting curve", type: "note", size: 38 },
  { id: "inter", x: 50, y: 82, label: "Interleaving", type: "note", size: 36 },
  { id: "review", x: 24, y: 71, label: "Review deck", type: "task", size: 36 },
];

const GRAPH_EDGES: [string, string][] = [
  ["hub", "spaced"],
  ["hub", "recall"],
  ["hub", "forget"],
  ["hub", "inter"],
  ["hub", "review"],
  ["spaced", "recall"],
  ["spaced", "forget"],
  ["inter", "review"],
];

const NODE_COLOR: Record<GraphNode["type"], string> = {
  note: colors.success,
  task: colors.info,
  project: colors.accent,
};
const NODE_ICON: Record<GraphNode["type"], IconName> = {
  note: "notes",
  task: "tasks",
  project: "folder",
};

function Graph() {
  const byId = Object.fromEntries(GRAPH_NODES.map((n) => [n.id, n]));
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        position: "relative",
        overflow: "hidden",
        background: `radial-gradient(circle, ${colors.borderSubtle} 1px, transparent 1px)`,
        backgroundSize: "24px 24px",
      }}
    >
      {/* edges */}
      <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} viewBox="0 0 100 100" preserveAspectRatio="none">
        {GRAPH_EDGES.map(([a, b]) => (
          <line
            key={`${a}-${b}`}
            x1={byId[a].x}
            y1={byId[a].y}
            x2={byId[b].x}
            y2={byId[b].y}
            stroke={colors.borderStrong}
            strokeWidth={1}
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>

      {/* nodes */}
      {GRAPH_NODES.map((n) => {
        const color = NODE_COLOR[n.type];
        const nodeStyle: CSSProperties = {
          position: "absolute",
          left: `${n.x}%`,
          top: `${n.y}%`,
          transform: "translate(-50%, -50%)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
        };
        return (
          <div key={n.id} style={nodeStyle}>
            <div
              style={{
                width: n.size,
                height: n.size,
                borderRadius: "50%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: colors.surfaceCard,
                border: `${n.focus ? 3 : 2}px solid ${color}`,
                boxShadow: n.focus ? `0 0 0 6px ${colors.accentSoft}` : "none",
              }}
            >
              <Icon name={NODE_ICON[n.type]} size={Math.round(n.size * 0.42)} color={color} />
            </div>
            <span style={{ marginTop: 6, fontSize: 11, lineHeight: 1.2, color: colors.textSecondary, textAlign: "center", maxWidth: 96 }}>{n.label}</span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------

const TITLES: Record<FeatureKey, ReactNode> = {
  chat: "Chats",
  notes: "Notes / Spaced repetition",
  tasks: "Tasks",
  habits: "Habits",
  graph: "Graph",
};

const SCREENS: Record<FeatureKey, () => ReactNode> = {
  chat: Chat,
  notes: Notes,
  tasks: Tasks,
  habits: Habits,
  graph: Graph,
};

export function FeatureMockups({ feature }: { feature: FeatureKey }) {
  const Screen = SCREENS[feature] ?? Chat;
  return (
    <AppChrome active={feature} title={TITLES[feature]}>
      <Screen />
    </AppChrome>
  );
}
