import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text as RNText, View, type StyleProp, type TextStyle } from "react-native";
import type { CalendarRepeat } from "@companion/core-bridge";
import {
  Icon,
  Text,
  colors,
  font,
  icon as iconSize,
  layout,
  motion,
  radius,
  space,
  transition,
  useDensity,
  type IconName,
  type PressState,
} from "@companion/design-system";
import { formatWhen } from "../CalendarItemInfo";
import { useCore } from "../CoreContext";
import { nodeKey } from "../graphModel";
import { reminderLabel } from "../reminders";
import { repeatLabel } from "../repeat";
import { Checkbox } from "../TaskEditor";
import { useTasks } from "../TasksProvider";
import { CanvasThumbnail } from "./CanvasThumbnail";
import { ChatGraph } from "./ChatGraph";
import { OpenEntityContext, OpenEventContext, ThreadLayoutContext } from "./context";
import type { GraphRoot, Preview } from "./renderTools";
import { WikiText } from "./WikiText";

// Inline previews (PLAN §6.8): the render_* tools ask the chat to show an entity instead of the
// assistant pasting it. The tool call carries only the id; each preview loads the live entity and
// stays live while the chat is open — tick a task off here or edit it elsewhere, and the card
// follows.

/** One inline preview in the thread. */
export function ChatPreview({ preview }: { preview: Preview }) {
  switch (preview.kind) {
    case "note":
      return <NotePreview id={preview.id} />;
    case "task":
      return <TaskPreview id={preview.id} />;
    case "event":
      return <EventPreview id={preview.id} />;
    case "canvas":
      return <CanvasPreview id={preview.id} />;
    case "graph":
      return <GraphPreview root={preview.type} id={preview.id} depth={preview.depth} />;
  }
}

/** What each preview last loaded, by preview. A preview remounts when a run finishes — the live
 *  stream's copy hands over to the saved reply's — and when a chat is reopened; drawing the last
 *  copy at once (then refreshing) keeps the thread from blinking and jumping. */
const lastLoaded = new Map<string, unknown>();
const LAST_LOADED_MAX = 100;

function remember(key: string, value: unknown) {
  lastLoaded.delete(key);
  lastLoaded.set(key, value);
  if (lastLoaded.size > LAST_LOADED_MAX) lastLoaded.delete(lastLoaded.keys().next().value as string);
}

/** Loads what a preview shows and reloads it whenever one of `events` fires, so the card stays
 *  true to its entity for as long as the chat is open. `missing` once a load fails: the entity is
 *  gone (deleted, trashed, or — for an event — moved to a new id), and the preview then draws
 *  nothing rather than a stale copy. */
function useLive<T>(key: string, load: () => Promise<T>, events: readonly string[]): { value: T | null; missing: boolean } {
  const { core } = useCore();
  const [state, setState] = useState<{ value: T | null; missing: boolean }>(() => ({
    value: (lastLoaded.get(key) as T | undefined) ?? null,
    missing: false,
  }));
  // What was last drawn, serialized: most reloads (an unrelated edit elsewhere) return the same
  // entity, and handing React a new copy of it would re-render — and re-lay out a graph — for
  // nothing.
  const shown = useRef<string | null>(null);
  const eventsKey = events.join(" ");
  useEffect(() => {
    let alive = true;
    const run = () => {
      load()
        .then((value) => {
          remember(key, value);
          const json = JSON.stringify(value);
          if (!alive || json === shown.current) return;
          shown.current = json;
          setState({ value, missing: false });
        })
        .catch(() => {
          lastLoaded.delete(key);
          shown.current = null;
          if (alive) setState((s) => ({ ...s, missing: true }));
        });
    };
    run();
    const offs = eventsKey.split(" ").map((name) => core.on(name, run));
    return () => {
      alive = false;
      offs.forEach((off) => off());
    };
  }, [core, key, load, eventsKey]);
  return state;
}

// --- cards -------------------------------------------------------------------

/** The inline note card: its title over a short Markdown rendering of the live body. */
function NotePreview({ id }: { id: string }) {
  const { notes } = useCore();
  const openEntity = useContext(OpenEntityContext);
  const load = useCallback(() => notes.get(id), [notes, id]);
  const { value: note, missing } = useLive(`note:${id}`, load, ["data.changed"]);
  if (missing || !note) return null;
  const body = note.contentMd.trim();
  return (
    <PreviewCard icon="file" title={note.title || "Untitled"} openLabel={note.title || "Note"} onOpen={openEntity ? () => openEntity("note", id) : undefined}>
      {body ? <View style={[styles.body, styles.clip]}>{renderMarkdown(body, 16)}</View> : null}
    </PreviewCard>
  );
}

/** The inline task card: a working checkbox, when it's due, its reminder and repeat, and the start
 *  of its notes. */
function TaskPreview({ id }: { id: string }) {
  const { tasks } = useCore();
  const store = useTasks();
  const openEntity = useContext(OpenEntityContext);
  const touch = useDensity() === "touch";
  const load = useCallback(() => tasks.get(id), [tasks, id]);
  const { value: fetched, missing } = useLive(`task:${id}`, load, ["data.changed"]);
  // The provider's row is the freshest (its checkbox flips optimistically); a repeating task's
  // definition isn't in that list, so fall back to the fetched copy.
  const task = store.byId(id) ?? fetched;
  if (missing || !task) return null;
  const done = task.status === "done";
  const cancelled = task.status === "cancelled";
  // A repeating definition isn't done or not done — its occurrences are.
  const seed = !!task.repeatRule && !task.repeatSeedId;
  const due = task.dueAt ? new Date(task.dueAt) : null;
  const overdue = !!due && !done && !cancelled && due.getTime() < Date.now();
  const meta: { icon: IconName; text: string; danger?: boolean }[] = [];
  if (task.startAt) meta.push({ icon: "calendar", text: `starts ${dateTime(new Date(task.startAt))}` });
  if (due) meta.push({ icon: "flag", text: `deadline ${dateTime(due)}`, danger: overdue });
  const reminders = task.reminders ?? [];
  if (reminders.length === 1) {
    const [r] = reminders;
    meta.push({ icon: "bell", text: r.at ? `remind ${dateTime(new Date(r.at))}` : `remind ${reminderLabel(r).toLowerCase()}` });
  } else if (reminders.length > 1) {
    meta.push({ icon: "bell", text: `${reminders.length} reminders` });
  }
  const repeat = repeatLabel(task.repeatRule);
  if (repeat) meta.push({ icon: "repeat", text: repeat.toLowerCase() });
  const notes = task.notesMd.trim();
  return (
    <PreviewCard
      leading={
        seed ? (
          <Icon name="repeat" size={iconSize.sm} color={colors.textQuaternary} />
        ) : (
          <Checkbox checked={done} size={touch ? 18 : 12} onPress={() => void store.setStatus(task.id, done ? "open" : "done")} />
        )
      }
      title={task.title || "Untitled task"}
      titleStyle={done || cancelled ? styles.titleDone : null}
      openLabel={task.title || "Task"}
      onOpen={openEntity ? () => openEntity("task", task.id) : undefined}
      footer={cancelled ? "cancelled" : undefined}
    >
      {meta.length > 0 || notes ? (
        <View style={styles.body}>
          {meta.length > 0 ? (
            <View style={styles.metaRow}>
              {meta.map((m) => (
                <View key={m.icon} style={styles.metaItem}>
                  <Icon name={m.icon} size={11} color={m.danger ? colors.danger : colors.textQuaternary} />
                  <Text variant="mono" tone={m.danger ? "danger" : "tertiary"} numberOfLines={1}>
                    {m.text}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
          {notes ? <View style={styles.clip}>{renderMarkdown(notes, 6)}</View> : null}
        </View>
      ) : null}
    </PreviewCard>
  );
}

/** The inline event card: when and where, its calendar and repeat, and the start of its details.
 *  Opening it is the shell's call (OpenEventContext). */
function EventPreview({ id }: { id: string }) {
  const { calendar } = useCore();
  const openEvent = useContext(OpenEventContext);
  const load = useCallback(
    () =>
      calendar.events.get(id).then((d) => {
        if (!d.item) throw new Error("event gone");
        return { item: d.item, calendarName: d.calendarName ?? "", repeat: d.repeat };
      }),
    [calendar, id],
  );
  const { value, missing } = useLive(`event:${id}`, load, ["calendar.changed", "data.changed"]);
  if (missing || !value) return null;
  const { item, calendarName, repeat } = value;
  const details = plainText(item.description);
  const footer = [calendarName, repeat ? repeatText(repeat) : null, item.pending ? "syncing" : null].filter(Boolean).join(" · ");
  return (
    <PreviewCard
      icon="calendar"
      iconColor={item.color ?? undefined}
      title={item.title || "Untitled event"}
      openLabel={item.title || "Event"}
      onOpen={openEvent ? () => openEvent(item) : undefined}
      footer={footer || undefined}
    >
      <View style={styles.body}>
        <Text variant="label" tone="secondary" numberOfLines={1}>
          {formatWhen(item)}
        </Text>
        {item.location ? (
          <Text variant="caption" tone="tertiary" numberOfLines={1}>
            {item.location}
          </Text>
        ) : null}
        {details ? (
          <Text variant="caption" tone="tertiary" numberOfLines={4} style={styles.details}>
            {details}
          </Text>
        ) : null}
      </View>
    </PreviewCard>
  );
}

/** The inline canvas card: a live miniature of the board, and what's on it. */
function CanvasPreview({ id }: { id: string }) {
  const { canvases } = useCore();
  const openEntity = useContext(OpenEntityContext);
  const touch = useDensity() === "touch";
  const load = useCallback(() => canvases.get(id), [canvases, id]);
  const { value: doc, missing } = useLive(`canvas:${id}`, load, ["canvases.changed", "data.changed"]);
  if (missing || !doc) return null;
  const groups = doc.nodes.filter((n) => n.kind === "group").length;
  const cards = doc.nodes.length - groups;
  const footer =
    doc.nodes.length === 0
      ? "empty"
      : [plural(cards, "card"), groups ? plural(groups, "group") : null, doc.edges.length ? plural(doc.edges.length, "arrow") : null]
          .filter(Boolean)
          .join(" · ");
  return (
    <PreviewCard
      icon="canvas"
      title={doc.canvas.name || "Untitled canvas"}
      openLabel={doc.canvas.name || "Canvas"}
      onOpen={openEntity ? () => openEntity("canvas", id) : undefined}
      wide
      footer={footer}
    >
      {doc.nodes.length > 0 ? (
        <CanvasThumbnail doc={doc} minHeight={touch ? 140 : 120} maxHeight={touch ? 220 : 260} />
      ) : (
        <View style={styles.body}>
          <Text variant="caption" tone="tertiary">
            Nothing on this canvas yet.
          </Text>
        </View>
      )}
    </PreviewCard>
  );
}

/** The inline graph: the entity at the center of everything linked to it, in the app's own graph
 *  renderer. The graph is interactive (drag, zoom, open a node), so only the title bar opens the
 *  entity itself. */
function GraphPreview({ root, id, depth }: { root: GraphRoot; id: string; depth: number }) {
  const { graph: graphApi } = useCore();
  const openEntity = useContext(OpenEntityContext);
  const touch = useDensity() === "touch";
  const load = useCallback(() => graphApi.neighborhood(root, id, depth), [graphApi, root, id, depth]);
  const { value: graph, missing } = useLive(`graph:${root}:${id}:${depth}`, load, ["data.changed"]);
  const center = graph?.nodes.find((n) => n.type === root && n.id === id);
  if (missing || !graph || !center) return null;
  const linked = graph.nodes.length - 1;
  const footer =
    linked === 0
      ? "no links yet"
      : `${plural(linked, "linked item")} · ${plural(graph.edges.length, "link")} · ${plural(depth, "hop")}`;
  return (
    <PreviewCard
      icon="graph"
      title={center.title || "Untitled"}
      openLabel={center.title || "Open"}
      onOpen={openEntity ? () => openEntity(root, id) : undefined}
      interactiveBody
      wide
      footer={footer}
    >
      <View style={{ height: touch ? 260 : 300 }}>
        <ChatGraph graph={graph} focusKey={nodeKey(root, id)} onOpenNode={openEntity} />
      </View>
    </PreviewCard>
  );
}

// --- chrome ------------------------------------------------------------------

/** The chrome every preview shares: a hairlined card in the prose column, a sunken title bar —
 *  icon, title, and an open affordance — then the kind's body and an optional mono footer. The
 *  whole card opens the entity, unless the body is interactive itself (the graph), when only the
 *  title bar does. */
function PreviewCard({
  icon,
  iconColor,
  leading,
  title,
  titleStyle,
  openLabel,
  onOpen,
  interactiveBody = false,
  wide = false,
  footer,
  children,
}: {
  icon?: IconName;
  iconColor?: string;
  /** Replaces the icon (the task card's checkbox). */
  leading?: ReactNode;
  title: string;
  titleStyle?: StyleProp<TextStyle>;
  openLabel: string;
  onOpen?: () => void;
  interactiveBody?: boolean;
  /** Fill the column (the canvas and graph need the room) instead of fitting the content. */
  wide?: boolean;
  footer?: string;
  children?: ReactNode;
}) {
  const threadLayout = useContext(ThreadLayoutContext);
  const head = (
    <View style={styles.head}>
      {leading ?? (icon ? <Icon name={icon} size={iconSize.sm} color={iconColor ?? colors.textQuaternary} /> : null)}
      <Text variant="label" numberOfLines={1} style={[styles.title, titleStyle]}>
        {title}
      </Text>
      {onOpen ? <Icon name="external" size={11} color={colors.textQuaternary} /> : null}
    </View>
  );
  const foot = footer ? (
    <View style={styles.foot}>
      <Text variant="mono" tone="quaternary" numberOfLines={1}>
        {footer}
      </Text>
    </View>
  ) : null;
  const card = [styles.card, wide ? styles.cardWide : null];
  return (
    <View style={[styles.wrap, threadLayout === "transcript" ? styles.wrapTranscript : null]}>
      {onOpen && !interactiveBody ? (
        <Pressable
          onPress={onOpen}
          aria-label={`Open ${openLabel}`}
          style={({ hovered, pressed }: PressState) => [card, transition("border-color", motion.fast), pressed || hovered ? styles.cardHover : null]}
        >
          {head}
          {children}
          {foot}
        </Pressable>
      ) : (
        <View style={card}>
          {onOpen ? (
            <Pressable onPress={onOpen} aria-label={`Open ${openLabel}`} style={({ hovered, pressed }: PressState) => [pressed || hovered ? styles.headHover : null]}>
              {head}
            </Pressable>
          ) : (
            head
          )}
          {children}
          {foot}
        </View>
      )}
    </View>
  );
}

// --- text helpers ----------------------------------------------------------------

/** A minimal Markdown renderer for the note and task cards: headings, bullet, numbered and check
 *  lists, blockquotes and paragraphs, with wikilinks made clickable. Capped at `maxLines` source
 *  lines to keep a preview a preview. */
function renderMarkdown(md: string, maxLines: number): ReactNode {
  const lines = md.split("\n");
  const shown = lines.slice(0, maxLines);
  const out: ReactNode[] = [];
  shown.forEach((raw, i) => {
    const line = raw.replace(/\s+$/, "");
    let m: RegExpExecArray | null;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      out.push(
        <RNText key={i} style={m[1].length === 1 ? styles.mdH1 : styles.mdH2}>
          {m[2]}
        </RNText>,
      );
    } else if ((m = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line))) {
      const checked = m[1] !== " ";
      out.push(
        <View key={i} style={styles.mdLi}>
          <View style={[styles.mdBox, checked ? styles.mdBoxOn : null]}>{checked ? <Icon name="check" size={8} color={colors.onAccent} strokeWidth={2.5} /> : null}</View>
          <View style={[styles.flex, checked ? styles.mdChecked : null]}>
            <WikiText value={m[2]} />
          </View>
        </View>,
      );
    } else if ((m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
      out.push(
        <View key={i} style={styles.mdLi}>
          <RNText style={styles.mdBullet}>{/^\d/.test(m[1]) ? m[1] : "•"}</RNText>
          <View style={styles.flex}>
            <WikiText value={m[2]} />
          </View>
        </View>,
      );
    } else if (/^>\s?/.test(line)) {
      out.push(
        <View key={i} style={styles.mdQuote}>
          <WikiText value={line.replace(/^>\s?/, "")} />
        </View>,
      );
    } else if (line.trim() === "") {
      out.push(<View key={i} style={{ height: space.xs }} />);
    } else {
      out.push(<WikiText key={i} value={line} />);
    }
  });
  if (lines.length > shown.length) {
    out.push(
      <RNText key="more" style={styles.mdMore}>
        …
      </RNText>,
    );
  }
  return out;
}

/** An event description as plain text: calendar providers often send HTML. */
function plainText(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/** "every 2 weeks until dec 1" — how an event repeats, as mono metadata. */
function repeatText(r: CalendarRepeat): string | null {
  if (r.freq === "none") return null;
  if (r.custom) return "repeats (custom)";
  const unit = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[r.freq];
  const n = r.interval && r.interval > 1 ? r.interval : 1;
  let text = n > 1 ? `every ${n} ${unit}s` : `repeats ${r.freq}`;
  if (r.until) {
    // A date marker: midnight UTC of the last day, so read it in UTC.
    const until = new Date(r.until);
    if (!Number.isNaN(until.getTime())) {
      text += ` until ${until.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).toLowerCase()}`;
    }
  }
  return text;
}

/** "fri, sep 19 · 5:00 pm", or just the date at midnight (a date-only due). */
function dateTime(d: Date): string {
  const date = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  if (d.getHours() === 0 && d.getMinutes() === 0) return date.toLowerCase();
  return `${date} · ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`.toLowerCase();
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

const styles = StyleSheet.create({
  // In the transcript, previews sit in the prose column (past the 18px mark).
  wrap: { width: "100%" },
  wrapTranscript: { maxWidth: 640, width: "100%", alignSelf: "center", paddingLeft: 18 + space.md },
  card: {
    alignSelf: "flex-start",
    maxWidth: "92%",
    minWidth: 240,
    backgroundColor: colors.surfaceCard,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.lg,
    overflow: "hidden",
  },
  cardWide: { alignSelf: "stretch", maxWidth: "100%" },
  cardHover: { borderColor: colors.borderDefault },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    height: layout.subToolbarH,
    paddingHorizontal: space.ml,
    backgroundColor: colors.surfaceSunken,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  headHover: { backgroundColor: colors.surfaceHover },
  title: { flex: 1, minWidth: 0 },
  titleDone: { color: colors.textTertiary, textDecorationLine: "line-through" },
  body: { padding: space.ml, gap: 3 },
  clip: { maxHeight: 280, overflow: "hidden" },
  foot: { paddingHorizontal: space.ml, paddingVertical: space.xs, borderTopWidth: 1, borderTopColor: colors.borderSubtle },
  flex: { flex: 1, minWidth: 0 },
  metaRow: { flexDirection: "row", flexWrap: "wrap", columnGap: space.md, rowGap: space.xxs },
  metaItem: { flexDirection: "row", alignItems: "center", gap: space.xs },
  details: { marginTop: space.xxs, lineHeight: 17 },
  mdH1: { fontFamily: font.sans, fontSize: font.size.md, fontWeight: font.weight.semibold, color: colors.textPrimary, marginBottom: 2 },
  mdH2: { fontFamily: font.sans, fontSize: font.size.base, fontWeight: font.weight.semibold, color: colors.textPrimary, marginTop: space.xs },
  mdLi: { flexDirection: "row", gap: space.sm, alignItems: "flex-start" },
  mdBullet: { color: colors.textQuaternary, fontSize: font.size.md, lineHeight: 21, minWidth: 8 },
  mdBox: {
    width: 11,
    height: 11,
    marginTop: 5,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.xs,
    alignItems: "center",
    justifyContent: "center",
  },
  mdBoxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  mdChecked: { opacity: 0.6 },
  mdQuote: { borderLeftWidth: 2, borderLeftColor: colors.borderDefault, paddingLeft: space.md },
  mdMore: { color: colors.textQuaternary, fontSize: font.size.md },
});
