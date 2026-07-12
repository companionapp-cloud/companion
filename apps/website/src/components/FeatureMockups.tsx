import {
  Badge,
  Button,
  Icon,
  Input,
  ListRow,
  ProgressRing,
  Text,
  colors,
  radius,
  space,
} from "@companion/design-system";
import { useState, type ReactNode } from "react";

// In-browser product mockups shown inside the landing page's "safari window" and the
// docs article. Ported from the design handoff (FeatureMockups.jsx): plain DOM for
// layout, design-system components for every visible control.

export type FeatureKey = "chat" | "notes" | "tasks" | "habits";

function Shell({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        height: "100%",
        background: colors.surfaceApp,
        display: "flex",
        flexDirection: "column",
        fontFamily: "'Geist', sans-serif",
      }}
    >
      {children}
    </div>
  );
}

function Header({ icon, title, badge }: { icon: string; title: string; badge?: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.md,
        padding: `${space.xl}px ${space.xxl}px`,
        borderBottom: `1px solid ${colors.borderSubtle}`,
        background: colors.surfaceCard,
      }}
    >
      <div
        style={{
          width: 30,
          height: 30,
          borderRadius: radius.md,
          background: colors.accentSoft,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name={icon as never} size={17} color={colors.accent} />
      </div>
      <Text variant="title">{title}</Text>
      {badge ? <Badge label={badge} tone="accent" /> : null}
    </div>
  );
}

/* ---------------- Ask / Chat ---------------- */

function Bubble({ me, children }: { me?: boolean; children: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: me ? "flex-end" : "flex-start" }}>
      <div
        style={{
          maxWidth: "78%",
          padding: `${space.lg}px ${space.xl}px`,
          borderRadius: 16,
          background: me ? colors.accent : colors.surfaceCard,
          border: me ? "none" : `1px solid ${colors.borderSubtle}`,
          borderBottomRightRadius: me ? 4 : 16,
          borderBottomLeftRadius: me ? 16 : 4,
          color: me ? colors.onAccent : colors.textPrimary,
          fontSize: 15,
          lineHeight: 1.5,
          fontWeight: 450,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function TaskLine({ label, done }: { label: string; done?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: space.md, padding: `${space.sm}px 0` }}>
      <div
        style={{
          width: 20,
          height: 20,
          borderRadius: 6,
          flexShrink: 0,
          border: `1.5px solid ${done ? colors.accent : colors.borderDefault}`,
          background: done ? colors.accent : "transparent",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {done ? <Icon name="today" size={12} color={colors.onAccent} /> : null}
      </div>
      <Text
        variant="body"
        style={{ color: done ? colors.textTertiary : colors.textPrimary, textDecorationLine: done ? "line-through" : "none" }}
      >
        {label}
      </Text>
    </div>
  );
}

function Chat() {
  const [text, setText] = useState("");
  return (
    <Shell>
      <Header icon="chat" title="Ask Companion" badge="AI" />
      <div
        style={{
          flex: 1,
          overflow: "hidden",
          padding: space.xxl,
          display: "flex",
          flexDirection: "column",
          gap: space.lg,
        }}
      >
        <Bubble me>Help me plan the week around Thursday's launch.</Bubble>
        <Bubble>
          Here's a plan. I turned it into three tasks and blocked focus time on Wednesday.
          <div
            style={{
              marginTop: space.md,
              padding: space.lg,
              background: colors.surfaceApp,
              borderRadius: radius.lg,
              border: `1px solid ${colors.borderSubtle}`,
            }}
          >
            <TaskLine label="Draft launch announcement" done />
            <TaskLine label="Record 60-second demo" />
            <TaskLine label="Schedule the release" />
          </div>
        </Bubble>
      </div>
      <div
        style={{
          padding: `${space.xl}px ${space.xxl}px`,
          borderTop: `1px solid ${colors.borderSubtle}`,
          background: colors.surfaceCard,
        }}
      >
        <div style={{ display: "flex", gap: space.md, alignItems: "center" }}>
          <div style={{ flex: 1 }}>
            <Input
              value={text}
              onChangeText={setText}
              placeholder="Message Companion…"
              leadingIcon={<Icon name="chat" size={16} color={colors.textTertiary} />}
            />
          </div>
          <Button variant="primary" size="md" label="Send" />
        </div>
      </div>
    </Shell>
  );
}

/* ---------------- Notes / Learn ---------------- */

function Notes() {
  const links = [
    { title: "Forgetting curve", subtitle: "Referenced 3 times", trailing: "3" },
    { title: "Active recall", subtitle: "Referenced 5 times", trailing: "5" },
    { title: "Interleaving", subtitle: "Referenced 2 times", trailing: "2" },
  ];
  return (
    <Shell>
      <Header icon="notes" title="Notes" badge="Connected" />
      <div style={{ flex: 1, overflow: "hidden", padding: space.xxl, display: "flex", gap: space.xxl, flexWrap: "wrap" }}>
        <div style={{ flex: 1.4, minWidth: 240, display: "flex", flexDirection: "column", gap: space.lg }}>
          <Text variant="heading">Spaced repetition</Text>
          <Text variant="body" tone="secondary" style={{ lineHeight: 26 }}>
            Reviewing material at increasing intervals fights the forgetting curve. Companion links every note you
            write, so revisiting one idea surfaces the others it depends on.
          </Text>
          <div style={{ display: "flex", gap: space.sm, flexWrap: "wrap", marginTop: space.xs }}>
            <Badge label="#learning" tone="neutral" />
            <Badge label="#memory" tone="neutral" />
            <Badge label="#study" tone="neutral" />
          </div>
        </div>
        <div
          style={{
            flex: 1,
            minWidth: 220,
            background: colors.surfaceCard,
            borderRadius: radius.xl,
            border: `1px solid ${colors.borderSubtle}`,
            padding: space.lg,
            display: "flex",
            flexDirection: "column",
            gap: space.xs,
            alignSelf: "flex-start",
          }}
        >
          <div style={{ padding: `${space.xs}px ${space.sm}px` }}>
            <Text variant="label" tone="tertiary">
              LINKED NOTES
            </Text>
          </div>
          {links.map((l) => (
            <ListRow
              key={l.title}
              title={l.title}
              subtitle={l.subtitle}
              trailing={l.trailing}
              icon={<Icon name="link" size={16} color={colors.accent} />}
              hasChildren
            />
          ))}
        </div>
      </div>
    </Shell>
  );
}

/* ---------------- Tasks / Plan ---------------- */

function Tasks() {
  const [done, setDone] = useState<Record<number, boolean>>({ 0: true, 3: true });
  const items = [
    { label: "Review pull requests", tag: "Work" },
    { label: "Outline Q3 roadmap", tag: "Work" },
    { label: "Book flights for offsite", tag: "Travel" },
    { label: "30-minute walk", tag: "Health" },
    { label: "Call Mom", tag: "Personal" },
  ];
  const count = items.length - Object.values(done).filter(Boolean).length;
  return (
    <Shell>
      <Header icon="tasks" title="Today" badge={`${count} left`} />
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: space.xxl,
          display: "flex",
          flexDirection: "column",
          gap: space.sm,
        }}
      >
        <Text variant="label" tone="tertiary" style={{ marginBottom: space.xs }}>
          FRIDAY · JULY 12
        </Text>
        {items.map((it, i) => {
          const isDone = !!done[i];
          return (
            <div
              key={it.label}
              onClick={() => setDone((d) => ({ ...d, [i]: !d[i] }))}
              style={{
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: space.lg,
                padding: `${space.lg}px ${space.xl}px`,
                background: colors.surfaceCard,
                border: `1px solid ${colors.borderSubtle}`,
                borderRadius: radius.lg,
              }}
            >
              <div
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: radius.full,
                  flexShrink: 0,
                  border: `1.5px solid ${isDone ? colors.accent : colors.borderDefault}`,
                  background: isDone ? colors.accent : "transparent",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {isDone ? <Icon name="today" size={13} color={colors.onAccent} /> : null}
              </div>
              <div style={{ flex: 1 }}>
                <Text
                  variant="body"
                  style={{
                    color: isDone ? colors.textTertiary : colors.textPrimary,
                    textDecorationLine: isDone ? "line-through" : "none",
                  }}
                >
                  {it.label}
                </Text>
              </div>
              <Badge label={it.tag} tone="neutral" />
            </div>
          );
        })}
      </div>
    </Shell>
  );
}

/* ---------------- Habits / Play ---------------- */

function Habits() {
  const [week, setWeek] = useState<Record<string, boolean>>({
    "Read-0": true,
    "Read-1": true,
    "Read-2": true,
    "Read-4": true,
    "Move-0": true,
    "Move-1": true,
    "Meditate-0": true,
    "Meditate-2": true,
    "Meditate-3": true,
  });
  const days = ["M", "T", "W", "T", "F", "S", "S"];
  const habits = [
    { name: "Read 20 pages", streak: 12 },
    { name: "Move 30 min", streak: 4 },
    { name: "Meditate", streak: 7 },
  ];
  const total = habits.length * 7;
  const filled = Object.values(week).filter(Boolean).length;
  return (
    <Shell>
      <Header icon="habits" title="Habits" badge="This week" />
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: space.xxl,
          display: "flex",
          flexDirection: "column",
          gap: space.xl,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.xxl,
            padding: space.xl,
            background: colors.surfaceCard,
            borderRadius: radius.xl,
            border: `1px solid ${colors.borderSubtle}`,
          }}
        >
          <ProgressRing value={filled / total} size={72} stroke={8} color={colors.accent} track={colors.surfaceSunken} />
          <div>
            <Text variant="heading">{Math.round((filled / total) * 100)}%</Text>
            <Text variant="body" tone="secondary">
              completed this week · keep the streak going
            </Text>
          </div>
        </div>
        {habits.map((h) => (
          <div
            key={h.name}
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.lg,
              padding: `${space.lg}px ${space.xl}px`,
              background: colors.surfaceCard,
              borderRadius: radius.lg,
              border: `1px solid ${colors.borderSubtle}`,
              flexWrap: "wrap",
            }}
          >
            <div style={{ flex: 1, minWidth: 130 }}>
              <Text variant="body" style={{ fontWeight: 550 }}>
                {h.name}
              </Text>
              <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 2 }}>
                <Icon name="habits" size={13} color={colors.accent} />
                <Text variant="caption" tone="accent">
                  {h.streak} day streak
                </Text>
              </div>
            </div>
            <div style={{ display: "flex", gap: space.sm }}>
              {days.map((d, i) => {
                const key = `${h.name.split(" ")[0]}-${i}`;
                const on = !!week[key];
                return (
                  <div
                    key={key}
                    onClick={() => setWeek((w) => ({ ...w, [key]: !w[key] }))}
                    style={{
                      cursor: "pointer",
                      width: 30,
                      height: 30,
                      borderRadius: radius.full,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 12,
                      fontWeight: 600,
                      fontFamily: "'Geist', sans-serif",
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
    </Shell>
  );
}

export function FeatureMockups({ feature }: { feature: FeatureKey }) {
  const map: Record<FeatureKey, () => ReactNode> = { chat: Chat, notes: Notes, tasks: Tasks, habits: Habits };
  const Cmp = map[feature] ?? Chat;
  return <Cmp />;
}
