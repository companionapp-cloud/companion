import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { pomodoroRemainingMs, type PomodoroState, type Task } from "@companion/core-bridge";
import { Icon, Spinner, Text, colors, type IconName } from "@companion/design-system";
import { useCore } from "../CoreContext";
import { openCaptureResult } from "../capture";
import type { WorkspaceSection } from "../nav-context";
import { formatCountdown, pomodoroHost, type GlassRect } from "./host";
import { usePomodoro } from "./usePomodoro";
import { usePomodoroEnabled } from "./usePomodoroEnabled";

// How long after a pomodoro runs out the panel still says so, rather than just "ready".
const LAST_OUTCOME_MS = 30 * 60 * 1000;
// The day's tally shows a full working day as slots: 7 hours of 25-minute pomodoros, each with
// its 5-minute break, is 14 — two rows of 7. Filled as they count.
const DAY_POMODOROS = 14;
const TALLY_ROW = Math.ceil(DAY_POMODOROS / 2);

/**
 * The desktop menu bar panel (`?pomodoro=1`), built like macOS Control Center: glass modules on
 * Control Center's grid of 62pt cells with 14pt gutters. The same cards always, and with the
 * pomodoro tool on, the timer's beneath them — so nothing moves when the tool is switched:
 *
 *   ┌──────────┬──────────┐
 *   │ ◉ today  │ ◉ capture│   today's date, and quick capture
 *   ├──────┬───┴──┬──────┤
 *   │tasks │notes │canvas│   open a tool in Companion
 *   ╞══════╧═╤════╧══════╡   ── with the pomodoro tool on ──
 *   │  timer │ ◉ toggle  │   a 2×2 tile like Now Playing (with the day's tally), beside two
 *   │  (2×2) │ ◉ toggle  │   capsule toggles like Wi-Fi and Bluetooth: what to do right now
 *   ├────────┴───────────┤
 *   │ task ─────●─────── │   a 4×1 slider module like Display: the task, and how far in —
 *   └────────────────────┘   or, once it's finished, a quick pick of the next
 *        ( Open Companion )     a glass pill like Edit Controls, in both
 *
 * As in Control Center there's no panel behind the modules: the window is transparent and each
 * module is its own piece of glass. On macOS that's native Liquid Glass the shell places under
 * each one from the boxes this page reports, and the shell fits the panel to the layout's height
 * (GlassLayer); elsewhere (and in a browser) the modules draw a faint dark fill with a bright
 * hairline edge themselves. White type throughout, as the glass is always dark.
 */
export function PomodoroView() {
  const { ready, enabled } = usePomodoroEnabled();
  const { state, now, apply } = usePomodoro(enabled);
  const glass = useGlassLayer();
  const loading = !ready || (enabled && !state);
  return (
    <View style={styles.root}>
      {loading ? (
        <View style={styles.loading}>
          <Spinner />
        </View>
      ) : (
        <GlassCtx.Provider value={glass}>
          <View ref={glass.panelRef as never} style={styles.panel}>
            <SharedCards now={now} />
            {enabled && state ? <TimerCards state={state} now={now} apply={apply} /> : null}
            <Module id="open" radius={RADIUS.pill} label="Open Companion" onPress={openApp} boxStyle={styles.pillBox} style={styles.pill}>
              <Text style={styles.pillLabel}>Open Companion</Text>
            </Module>
          </View>
        </GlassCtx.Provider>
      )}
    </View>
  );
}

const openTask = (id: string) => openCaptureResult({ kind: "task", id });
const openSection = (section: WorkspaceSection) => () => openCaptureResult({ kind: "browse", section });
const openToday = () => openCaptureResult({ kind: "view", view: "today" });
const openCapture = () => pomodoroHost()?.capture?.();
// The main window as it was left; where no shell can bring it forward, the task list.
const openApp = () => {
  const host = pomodoroHost();
  if (host?.openApp) host.openApp();
  else openSection("tasks")();
};

/** The cards the panel always has: today's date, quick capture, and a way into each tool. */
function SharedCards({ now }: { now: number }) {
  const today = new Date(now);
  return (
    <>
      <View style={styles.row}>
        <View style={styles.cell}>
          <Module id="today" radius={RADIUS.capsule} label="Open Today" onPress={openToday} style={styles.capsule}>
            <View style={styles.capsuleBody}>
              <View style={styles.circle}>
                <Text style={styles.dayNumber}>{today.getDate()}</Text>
              </View>
              <Label title={today.toLocaleDateString(undefined, { weekday: "long" })} subtitle={today.toLocaleDateString(undefined, { month: "short", day: "numeric" })} />
            </View>
          </Module>
        </View>
        <View style={styles.cell}>
          <Toggle id="capture" icon="capture" title="Capture" subtitle="Quick add" on onPress={openCapture} />
        </View>
      </View>
      <View style={styles.row}>
        <Shortcut id="tasks" icon="tasks" label="Tasks" onPress={openSection("tasks")} />
        <Shortcut id="notes" icon="notes" label="Notes" onPress={openSection("notes")} />
        <Shortcut id="canvases" icon="canvas" label="Canvases" onPress={openSection("canvases")} />
      </View>
    </>
  );
}

/** The pomodoro timer's cards, with the tool on. A pomodoro is a 25-minute block worked one task
 *  at a time: finishing the task counts toward it and stops the clock until the next is picked —
 *  here, from a short list, or with the stopwatch on any task. The clock can be paused, and while
 *  it waits on the next task, a pomodoro with a task done can end there and take its break. */
function TimerCards({ state, now, apply }: { state: PomodoroState; now: number; apply: (s: PomodoroState) => void }) {
  const { pomodoro } = useCore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = (call: () => Promise<PomodoroState>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    call()
      .then(apply, (err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const { running, last } = state;
  const breakEndsAt = state.breakEndsAt ? Date.parse(state.breakEndsAt) : null;
  const doneLabel = (n: number) => `${n} done`;

  let mode: string;
  let caption: string;
  let countdown: string;
  let progress = 0;
  let taskId: string | null = null;
  let rowTitle: string;
  // Waiting for the next task: the task row becomes a quick pick.
  let picking = false;
  let toggles: [ToggleProps, ToggleProps];
  // The tile's pause / play button, while a task is in front of the clock.
  let clock: { icon: IconName; label: string; onPress: () => void } | null = null;
  const cancel: ToggleProps = { icon: "close", title: "Cancel", subtitle: "No credit", onPress: () => act(pomodoro.cancel) };

  if (running) {
    const paused = !!running.pausedAt;
    const left = pomodoroRemainingMs(running, now);
    mode = paused ? "Paused" : "Focus";
    caption = running.tasksDone > 0 ? doneLabel(running.tasksDone) : paused ? "paused" : "remaining";
    countdown = formatCountdown(left);
    progress = 1 - left / (running.durationSec * 1000);
    if (running.taskId) {
      taskId = running.taskId;
      rowTitle = running.taskTitle.trim() || "Untitled task";
      toggles = [{ icon: "check", title: "Complete", subtitle: "Then next", on: true, onPress: () => act(pomodoro.complete) }, cancel];
      clock = paused
        ? { icon: "play", label: "Resume the clock", onPress: () => act(pomodoro.resume) }
        : { icon: "pause", label: "Pause the clock", onPress: () => act(pomodoro.pause) };
    } else {
      // The task is done: the clock waits on the next one — or this pomodoro can end here.
      picking = true;
      rowTitle = "Next task";
      toggles = [
        running.tasksDone > 0
          ? { icon: "check", title: "Break now", subtitle: "It counts", on: true, onPress: () => act(pomodoro.finish) }
          : { icon: "tasks", title: "Next task", subtitle: "Pick below", inert: true },
        cancel,
      ];
    }
  } else if (breakEndsAt != null) {
    mode = "Break";
    caption = "of your break";
    countdown = formatCountdown(breakEndsAt - now);
    const length = last?.breakEndsAt && last.endedAt ? Date.parse(last.breakEndsAt) - Date.parse(last.endedAt) : 5 * 60 * 1000;
    progress = 1 - (breakEndsAt - now) / Math.max(length, 1);
    rowTitle = "On a break";
    toggles = [
      { icon: "check", title: "Counted", subtitle: doneLabel(last?.tasksDone ?? 0), on: true },
      { icon: "chevronRight", title: "Skip break", subtitle: "Resume", onPress: () => act(pomodoro.skipBreak) },
    ];
  } else {
    mode = "Ready";
    caption = "per pomodoro";
    countdown = formatCountdown(25 * 60 * 1000);
    rowTitle = "No task";
    const recent = last?.endedAt && now - Date.parse(last.endedAt) < LAST_OUTCOME_MS ? last : null;
    if (recent?.outcome === "expired") {
      const again = recent.taskId;
      toggles = [
        again
          ? { icon: "timer", title: "Go again", subtitle: "Same task", on: true, onPress: () => act(() => pomodoro.start(again)) }
          : { icon: "timer", title: "Go again", subtitle: "Use ⏱ on a task", inert: true },
        { icon: "close", title: "Time’s up", subtitle: "No credit" },
      ];
    } else {
      // Nothing running: the controls stay where they are, dimmed, as Control Center's do.
      toggles = [
        { icon: "check", title: "Complete", subtitle: "Nothing on", inert: true },
        { icon: "close", title: "Cancel", subtitle: "Nothing on", inert: true },
      ];
    }
  }

  const clamped = Math.min(Math.max(progress, 0), 1);
  return (
    <>
      <View style={styles.row}>
        {/* The timer, where Now Playing sits, with the day's tally: a dot per pomodoro that
            counted. */}
        <Module id="timer" radius={RADIUS.tile} style={styles.tile}>
          <View style={styles.tileHead}>
            <Text style={styles.tileMode}>{mode}</Text>
            {clock ? (
              <Pressable
                onPress={clock.onPress}
                disabled={busy}
                aria-label={clock.label}
                style={({ pressed }) => [styles.noFocusRing, styles.clockButton, pressed ? styles.pickPressed : null]}
              >
                <Icon name={clock.icon} size={14} strokeWidth={2.5} color={WHITE} />
              </Pressable>
            ) : null}
          </View>
          <View>
            <Text style={styles.big}>{countdown}</Text>
            <View style={styles.tileFoot}>
              <Text style={styles.subtitle} numberOfLines={1}>
                {caption}
              </Text>
              <Tally count={state.todayCount} />
            </View>
          </View>
        </Module>
        <View style={styles.column}>
          <Toggle {...toggles[0]} id="toggle-1" disabled={busy} />
          <Toggle {...toggles[1]} id="toggle-2" disabled={busy} />
        </View>
      </View>

      {picking ? (
        <NextTaskPicker now={now} error={error} disabled={busy} onPick={(id) => act(() => pomodoro.start(id))} />
      ) : (
        // The task, drawn like the Display slider: how far into the pomodoro (or break). A press
        // opens the task in Companion.
        <Module id="task" radius={RADIUS.slider} style={styles.slider} label="Open the task" onPress={taskId ? () => openTask(taskId!) : undefined}>
          <Text style={styles.title} numberOfLines={1}>
            {error ?? rowTitle}
          </Text>
          <View style={styles.sliderRow}>
            <Icon name="timer" size={14} strokeWidth={2} color={WHITE} />
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${Math.round(clamped * 100)}%` }]} />
            </View>
            <Icon name="check" size={14} strokeWidth={2.25} color={WHITE} />
          </View>
        </Module>
      )}
    </>
  );
}

/** The day's tally: a full working day of pomodoros as two rows of slots, filled as they count;
 *  past a full day, a "+N" for the rest. */
function Tally({ count }: { count: number }) {
  const extra = count - DAY_POMODOROS;
  const rows = [0, TALLY_ROW].map((from) => Array.from({ length: Math.min(TALLY_ROW, DAY_POMODOROS - from) }, (_, i) => from + i));
  return (
    <View style={styles.tally} aria-label={`${count} of ${DAY_POMODOROS} pomodoros today`}>
      <View style={styles.tallyRows}>
        {rows.map((row, r) => (
          <View key={r} style={styles.dots}>
            {row.map((i) => (
              <View key={i} style={[styles.dot, i < count ? styles.dotOn : null]} />
            ))}
          </View>
        ))}
      </View>
      {extra > 0 ? <Text style={styles.tallyExtra}>+{extra}</Text> : null}
    </View>
  );
}

// How many open tasks the quick pick offers.
const PICK_COUNT = 3;

/** The next task, picked from a few open ones — due or starting by the end of today first, then
 *  the most recently touched. Picking one puts it in front of the running pomodoro and starts its
 *  clock again. */
function NextTaskPicker({ now, error, disabled, onPick }: { now: number; error: string | null; disabled?: boolean; onPick: (id: string) => void }) {
  const { core, tasks } = useCore();
  const [open, setOpen] = useState<Task[] | null>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      tasks.list().then(
        (all) => live && setOpen(all),
        (err) => console.warn("pomodoro: list tasks", err),
      );
    void load();
    const offs = ["tasks.changed", "data.changed"].map((name) => core.on(name, () => void load()));
    return () => {
      live = false;
      offs.forEach((off) => off());
    };
  }, [core, tasks]);

  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  const soon = (t: Task) => [t.dueAt, t.startAt].some((at) => at != null && Date.parse(at) <= endOfToday.getTime());
  const picks = (open ?? [])
    .filter((t) => t.status === "open" && !t.someday && !(t.repeatRule && !t.repeatSeedId))
    .sort((a, b) => Number(soon(b)) - Number(soon(a)) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, PICK_COUNT);

  return (
    <Module id="next" radius={RADIUS.slider} style={styles.picker}>
      <Text style={styles.pickerHead}>{error ?? "Next task — the clock waits till you pick"}</Text>
      {open && picks.length === 0 ? (
        <Pressable onPress={openCapture} style={({ pressed }) => [styles.noFocusRing, styles.pick, pressed ? styles.pickPressed : null]}>
          <Icon name="capture" size={14} strokeWidth={2} color={WHITE} />
          <Text style={styles.pickTitle}>No open tasks — capture one</Text>
        </Pressable>
      ) : (
        picks.map((t) => (
          <Pressable
            key={t.id}
            onPress={() => onPick(t.id)}
            disabled={disabled}
            aria-label={`Work on ${t.title || "Untitled task"}`}
            style={({ pressed }) => [styles.noFocusRing, styles.pick, pressed ? styles.pickPressed : null]}
          >
            <View style={styles.pickRing} />
            <Text style={styles.pickTitle} numberOfLines={1}>
              {t.title.trim() || "Untitled task"}
            </Text>
            {soon(t) ? <Text style={styles.pickHint}>Today</Text> : null}
          </Pressable>
        ))
      )}
    </Module>
  );
}

interface ToggleProps {
  icon: IconName;
  title: string;
  subtitle: string;
  /** A pressable toggle acts; without one the capsule only reports (like "Bluetooth, On"). */
  onPress?: () => void;
  /** Lit: a solid white circle with a coloured glyph, like an enabled toggle. */
  on?: boolean;
  /** Unavailable right now: dimmed, and nothing to press. */
  inert?: boolean;
}

/** How modules take part in the glass: `ref` registers a module's element and corner radius so
 *  the shell can put glass under it, `panelRef` the panel whose height the shell fits the window
 *  to, and `style` is a module's own look — nothing where the glass is native, a drawn fill and
 *  edge where it isn't. */
interface GlassLayer {
  ref: (key: string, radius: number) => (node: unknown) => void;
  panelRef: (node: unknown) => void;
  style: ViewStyle;
}

const GlassCtx = createContext<GlassLayer>({ ref: () => () => {}, panelRef: () => {}, style: {} });

/** Collects the panel's height and its modules' boxes after every render and hands them to the
 *  shell when they change, so the window and its glass track the layout. */
function useGlassLayer(): GlassLayer {
  const setGlass = pomodoroHost()?.setGlass;
  const nodes = useRef(new Map<string, { node: HTMLElement; radius: number }>());
  const refs = useRef(new Map<string, (node: unknown) => void>());
  const panel = useRef<HTMLElement | null>(null);
  const sent = useRef("");

  const ref = useCallback((key: string, radius: number) => {
    const id = `${key}:${radius}`;
    let cb = refs.current.get(id);
    if (!cb) {
      cb = (node: unknown) => {
        if (node) nodes.current.set(key, { node: node as HTMLElement, radius });
        else nodes.current.delete(key);
      };
      refs.current.set(id, cb);
    }
    return cb;
  }, []);
  const panelRef = useCallback((node: unknown) => {
    panel.current = node as HTMLElement | null;
  }, []);

  useLayoutEffect(() => {
    if (!setGlass || typeof panel.current?.getBoundingClientRect !== "function") return;
    const rects: GlassRect[] = [];
    for (const { node, radius } of nodes.current.values()) {
      if (typeof node.getBoundingClientRect !== "function") continue;
      const b = node.getBoundingClientRect();
      rects.push({ x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), r: radius });
    }
    const height = Math.ceil(panel.current.getBoundingClientRect().height);
    const key = JSON.stringify({ height, rects });
    if (key === sent.current) return;
    sent.current = key;
    setGlass({ height, rects });
  });

  return { ref, panelRef, style: setGlass ? styles.glassNative : styles.glass };
}

/** One glass module. `boxStyle` sizes and places it; `style` lays out what's on it. Pressable
 *  modules take no ref here, so it's the box around them that gets measured. */
function Module({
  id,
  radius,
  label,
  onPress,
  disabled,
  boxStyle,
  style,
  children,
}: {
  id: string;
  radius: number;
  label?: string;
  onPress?: () => void;
  disabled?: boolean;
  boxStyle?: StyleProp<ViewStyle>;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  const glass = useContext(GlassCtx);
  const ref = glass.ref(id, radius) as never;
  if (!onPress)
    return (
      <View ref={ref} style={[boxStyle, glass.style, { borderRadius: radius }, style]}>
        {children}
      </View>
    );
  return (
    <View ref={ref} style={boxStyle}>
      <Pressable
        onPress={onPress}
        disabled={disabled}
        aria-label={label}
        style={({ pressed }) => [styles.noFocusRing, glass.style, { borderRadius: radius }, style, pressed ? styles.pressed : null]}
      >
        {children}
      </Pressable>
    </View>
  );
}

/** A capsule toggle, like Wi-Fi: a round glyph and a two-line label. */
function Toggle({ id, icon, title, subtitle, onPress, on, inert, disabled }: ToggleProps & { id: string; disabled?: boolean }) {
  return (
    <Module id={id} radius={RADIUS.capsule} label={title} onPress={inert ? undefined : onPress} disabled={disabled} style={styles.capsule}>
      <View style={[styles.capsuleBody, inert ? styles.inert : null]}>
        <View style={[styles.circle, on ? styles.circleOn : null]}>
          <Icon name={icon} size={16} strokeWidth={2.5} color={on ? colors.accent : WHITE} />
        </View>
        <Label title={title} subtitle={subtitle} />
      </View>
    </Module>
  );
}

/** A small tile that opens one of Companion's tools: its glyph over its name. */
function Shortcut({ id, icon, label, onPress }: { id: string; icon: IconName; label: string; onPress: () => void }) {
  return (
    <Module id={id} radius={RADIUS.shortcut} label={`Open ${label}`} onPress={onPress} boxStyle={styles.cell} style={styles.shortcut}>
      <Icon name={icon} size={18} strokeWidth={2} color={WHITE} />
      <Text style={styles.shortcutLabel} numberOfLines={1}>
        {label}
      </Text>
    </Module>
  );
}

function Label({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <View style={{ flexShrink: 1 }}>
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      <Text style={styles.subtitle} numberOfLines={1}>
        {subtitle}
      </Text>
    </View>
  );
}

const WHITE = "#ffffff";
// Control Center's grid.
const CELL = 62;
const GAP = 14;
const CIRCLE = 36;
// Corner radii, shared with the native glass under each module.
const RADIUS = { tile: 26, capsule: CELL / 2, slider: 22, shortcut: 22, pill: 12 };
// SF, as the rest of the menu bar uses; SF Rounded for the numbers, like the Clock app.
const SYSTEM = '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';
const ROUNDED = 'ui-rounded, "SF Pro Rounded", -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
// CSS that react-native's style types don't know (react-native-web passes it through).
const web = (style: Record<string, unknown>) => style as ViewStyle;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "transparent" },
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  // Sized by its layout (not the window), so the shell can fit the window to it.
  panel: { padding: GAP, gap: GAP },
  row: { flexDirection: "row", gap: GAP },
  column: { flex: 1, gap: GAP },
  // An even share of a row. Unpadded, so the row splits evenly whatever each module's padding.
  cell: { flex: 1 },

  // Drawn glass, where the shell has none: a faint dark fill, a bright hairline edge and a
  // highlight along the top.
  glass: {
    backgroundColor: "rgba(0,0,0,0.16)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.22)",
    ...web({ boxShadow: "inset 0 1px 0 rgba(255,255,255,0.10)" }),
  },
  // Native glass draws the module; the page only lays out what sits on it.
  glassNative: { borderWidth: 1, borderColor: "transparent" },
  // No web focus ring: the panel is key the moment it opens, and Control Center draws none.
  noFocusRing: web({ outlineStyle: "none" }),
  pressed: { backgroundColor: "rgba(255,255,255,0.16)" },
  inert: { opacity: 0.4 },

  // 2×2, like Now Playing.
  tile: { width: CELL * 2 + GAP, height: CELL * 2 + GAP, padding: 14, justifyContent: "space-between" },
  tileHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", minHeight: 28 },
  tileFoot: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 6 },
  // Now Playing's play / pause, in the corner of the timer.
  clockButton: { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.2)" },
  tileMode: { fontFamily: SYSTEM, fontSize: 13, fontWeight: "600", color: "rgba(255,255,255,0.72)" },
  big: { fontFamily: ROUNDED, fontSize: 34, lineHeight: 38, fontWeight: "600", color: WHITE, ...web({ fontVariantNumeric: "tabular-nums" }) },

  // 2×1 capsules, like Wi-Fi and Focus: a 36pt circle, inset about as far from the left as from
  // the top.
  capsule: { height: CELL, justifyContent: "center", paddingLeft: (CELL - CIRCLE) / 2 - 1, paddingRight: 10 },
  capsuleBody: { flexDirection: "row", alignItems: "center", gap: 9 },
  circle: { width: CIRCLE, height: CIRCLE, borderRadius: CIRCLE / 2, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.2)" },
  circleOn: { backgroundColor: WHITE },
  dayNumber: { fontFamily: ROUNDED, fontSize: 16, fontWeight: "700", color: WHITE, ...web({ fontVariantNumeric: "tabular-nums" }) },
  title: { fontFamily: SYSTEM, fontSize: 13, lineHeight: 16, fontWeight: "600", color: WHITE },
  subtitle: { fontFamily: SYSTEM, fontSize: 12, lineHeight: 15, fontWeight: "500", color: "rgba(255,255,255,0.72)" },

  // A third of a row: glyph over name.
  shortcut: { height: CELL, alignItems: "center", justifyContent: "center", gap: 4 },
  shortcutLabel: { fontFamily: SYSTEM, fontSize: 12, fontWeight: "600", color: WHITE },

  // 4×1, grown to its rows: the next-task quick pick.
  picker: { paddingHorizontal: 10, paddingTop: 10, paddingBottom: 6, gap: 2 },
  pickerHead: { fontFamily: SYSTEM, fontSize: 12, fontWeight: "600", color: "rgba(255,255,255,0.72)", paddingHorizontal: 6, paddingBottom: 4 },
  pick: { flexDirection: "row", alignItems: "center", gap: 10, height: 30, paddingHorizontal: 6, borderRadius: 10 },
  pickPressed: { backgroundColor: "rgba(255,255,255,0.14)" },
  pickRing: { width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, borderColor: "rgba(255,255,255,0.72)" },
  pickTitle: { flex: 1, fontFamily: SYSTEM, fontSize: 13, fontWeight: "500", color: WHITE },
  pickHint: { fontFamily: SYSTEM, fontSize: 11, fontWeight: "600", color: "rgba(255,255,255,0.6)" },

  // 4×1, like Display.
  slider: { height: CELL, paddingHorizontal: 16, justifyContent: "center", gap: 8 },
  sliderRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  track: { flex: 1, height: 6, borderRadius: 3, backgroundColor: "rgba(255,255,255,0.28)", overflow: "hidden" },
  fill: { height: 6, borderRadius: 3, backgroundColor: WHITE },

  // Like Edit Controls: a small glass pill.
  pillBox: { alignSelf: "center" },
  pill: { height: 24, paddingHorizontal: 12, justifyContent: "center" },
  pillLabel: { fontFamily: SYSTEM, fontSize: 13, fontWeight: "500", color: WHITE },

  tally: { flexDirection: "row", alignItems: "center", gap: 3 },
  tallyRows: { gap: 3 },
  dots: { flexDirection: "row", gap: 3 },
  dot: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: "rgba(255,255,255,0.28)" },
  dotOn: { backgroundColor: WHITE },
  tallyExtra: { fontFamily: SYSTEM, fontSize: 10, fontWeight: "600", color: WHITE },
});
