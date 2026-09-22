import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Platform } from "react-native";
import type { OnboardingOutcome } from "@companion/core-bridge";
import { useSync } from "../SyncProvider";
import { useNotes } from "../NotesProvider";
import { useTasks } from "../TasksProvider";
import { useProjects } from "../ProjectsProvider";
import { useCanvases } from "../canvas/CanvasesProvider";
import { useCore } from "../CoreContext";
import { AnchorRegistryContext, anchorRect, createAnchorRegistry, type AnchorRegistry } from "./anchors";
import { useOnboardingState } from "./OnboardingState";
import { TOURS, TOUR_BY_ID, stepAnchors, type TourChoice, type TourContext, type TourDef, type TourId, type TourPlan, type TourStep } from "./tours";
import { TourOverlay } from "./TourOverlay";
import type { Layout, Place, TourHost } from "./host";

// Runs the tutorials (tours) in whichever shell mounts it: the desktop AppShell, the mobile web
// shell or the native app, each describing itself through a TourHost. It starts a tool's
// tutorial the first time the user opens that tool, and draws it. What was settled comes from
// OnboardingState (synced rows in core); the tutorials themselves are in tours.ts.
//
// A tutorial starts by itself only once the welcome sheet is read and the user said yes to
// tutorials, and only when the user opens a page themselves:
// - a page with a tutorial of its own (Today, Notes, an area's overview, …) starts it shortly
//   after it shows, unless that tutorial's current version is settled;
// - the desktop's quick capture and areas tutorials have no page, so each starts on the first page
//   the user opens that has no tutorial of its own left to show (never the page the app opened
//   on, and never Settings); on a phone they belong to Home, once the user comes back to it;
// - on a device that syncs, not before the first sync has had its chance to bring in what
//   another device already settled.
// A tutorial ends on its own page; the next one waits for the user to open another tool.

/** How long a page shows before its tutorial starts, so it can draw first. */
const START_DELAY_MS = 600;
/** How long a replay waits for its page before giving up. */
const QUEUE_TIMEOUT_MS = 4000;
/** The longest the first sync may hold tutorials back. */
const SYNC_GATE_MS = 5000;

export type TourStatus = "new" | OnboardingOutcome;

export interface TourEntry {
  tour: TourDef;
  status: TourStatus;
  /** Its page can be reached now (an area page needs an area). */
  available: boolean;
}

export interface OnboardingController {
  /** Every tutorial, with where the user stands with it. */
  tours: TourEntry[];
  /** Go to a tutorial's page and run it, settled or not. */
  replay: (id: TourId) => void;
  /** Forget every settled tutorial, on every device, so each shows again. */
  resetAll: () => Promise<void>;
  /** Desktop: a tutorial step needs the sidebar held open. */
  holdRail: boolean;
  /** The page state the showing step needs (TourStep.view), or null. */
  view: string | null;
}

const OnboardingContext = createContext<OnboardingController | null>(null);

/** The tutorials, or null where no shell runs them. */
export function useOnboarding(): OnboardingController | null {
  return useContext(OnboardingContext);
}

/** The state a tutorial step needs the page in, such as "today.agenda", or null. A page with
 *  more than one state (segments) shows this one over its own while the step is up. */
export function useTourView(): string | null {
  return useContext(OnboardingContext)?.view ?? null;
}

// Whether a tutorial host is mounted, for Settings › Tutorials to show only where tutorials run.
let hostMounted = false;
export function toursAvailable(): boolean {
  return hostMounted;
}

interface ActiveTour {
  tour: TourDef;
  steps: TourStep[];
  index: number;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Where a tutorial may keep running: the pages its steps visit (anywhere, for an idle one). */
function runsHere(plan: TourPlan, place: Place): boolean {
  if (plan.startsOn === "idle") return true;
  return (plan.runsOn ?? plan.startsOn).includes(place);
}

/** Whether an anchor is on the page. The web can measure right away; native can only tell that
 *  its view is mounted (the overlay measures it once the step shows). */
function anchorPresent(registry: AnchorRegistry, id: string): boolean {
  return Platform.OS === "web" ? anchorRect(registry, id) !== null : registry.nodes(id).length > 0;
}

function blurFocus() {
  if (typeof document === "undefined") return;
  (document.activeElement as HTMLElement | null)?.blur?.();
}

export function OnboardingProvider({ host, children }: { host: TourHost; children: ReactNode }) {
  const state = useOnboardingState();
  const sync = useSync();
  const notes = useNotes();
  const tasks = useTasks();
  const projects = useProjects();
  const canvases = useCanvases();
  const canvasApi = useCore().canvases;
  const registry = useMemo(createAnchorRegistry, []);
  const layout: Layout = host.layout;
  const plan = useCallback((t: TourDef) => t[layout], [layout]);

  hostMounted = true;
  useEffect(() => {
    hostMounted = true;
    return () => {
      hostMounted = false;
    };
  }, []);

  // What tutorials read while they run: always the latest stores and host (see TourContext).
  const live = useRef({ host, notes, tasks, projects, canvases, canvasApi });
  live.current = { host, notes, tasks, projects, canvases, canvasApi };
  const ctx = useMemo<TourContext>(
    () => ({
      get notes() {
        return live.current.notes;
      },
      get tasks() {
        return live.current.tasks;
      },
      get projects() {
        return live.current.projects;
      },
      get canvases() {
        return live.current.canvases;
      },
      get canvasApi() {
        return live.current.canvasApi;
      },
      doc: () => live.current.host.doc,
      go: (to) => live.current.host.go(to),
      openNote: (id) => live.current.host.openNote(id),
      openTask: (id) => live.current.host.openTask(id),
      openCanvas: (id) => live.current.host.openCanvas(id),
      openArea: (id) => live.current.host.openArea(id),
      openProject: (id) => live.current.host.openProject(id),
      openSettings: (section) => live.current.host.openSettings(section),
      back: () => live.current.host.back(),
      waitFor: (test, timeoutMs = 3000) =>
        new Promise<boolean>((resolve) => {
          const until = Date.now() + timeoutMs;
          const tick = () => {
            if (test()) resolve(true);
            else if (Date.now() >= until) resolve(false);
            else setTimeout(tick, 50);
          };
          tick();
        }),
      picked: {},
    }),
    [],
  );

  const { settled, outcome, record } = state;
  // Pending: its current version isn't settled, nor the tutorial that covers the same ground.
  const isPending = useCallback(
    (t: TourDef) => settled(t.id) < t.version && !(t.unless && settled(t.unless) >= TOUR_BY_ID[t.unless].version),
    [settled],
  );

  // --- the first sync gets a chance to bring in what was settled elsewhere --------------------
  const syncSettled =
    !sync.connected || sync.lastSyncedAt != null || sync.status === "error" || sync.status === "locked" || sync.needsReauth;
  const [gateOpen, setGateOpen] = useState(syncSettled);
  useEffect(() => {
    if (gateOpen) return;
    if (syncSettled) {
      setGateOpen(true);
      return;
    }
    const t = setTimeout(() => setGateOpen(true), SYNC_GATE_MS);
    return () => clearTimeout(t);
  }, [gateOpen, syncSettled]);

  // --- the running tutorial ----------------------------------------------------------------
  const [active, setActive] = useState<ActiveTour | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [starting, setStarting] = useState<TourDef | null>(null);
  const startingRef = useRef<TourDef | null>(null);
  // A replay asked for from Settings, waiting for its page to show.
  const [queued, setQueued] = useState<{ id: TourId; at: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const { place, placeKey } = host;
  const placeKeyRef = useRef(placeKey);
  placeKeyRef.current = placeKey;
  // The page the last tutorial ended on: nothing else starts there until the user moves on.
  const lastEnded = useRef<string | null>(null);
  // Whether the user has moved since the app started (see TourPlan.afterMoving).
  const firstKey = useRef(placeKey);
  const navigated = useRef(false);

  const start = useCallback(
    async (tour: TourDef) => {
      if (startingRef.current || activeRef.current) return;
      const p = plan(tour);
      startingRef.current = tour;
      setStarting(tour);
      try {
        ctx.picked = {};
        try {
          await p.prepare?.(ctx);
        } catch {
          // Placeholder content that couldn't be made leaves the steps that don't need it.
        }
        const present = (s: TourStep) => stepAnchors(s).some((id) => anchorPresent(registry, id));
        const candidates = p.steps.filter((s) => s.when?.(ctx) ?? true);
        // Steps from the first one that opens another screen on can't be checked from here.
        const firstGo = candidates.findIndex((s) => s.go);
        const elsewhere = (i: number) => firstGo >= 0 && i >= firstGo;
        // Give the page a moment to draw what the first steps point at (a list still loading, a
        // note the tutorial just opened, the sidebar sliding out).
        await ctx.waitFor(() => candidates.some((s, i) => !elsewhere(i) && (!s.anchor || present(s))), 2500);
        await delay(150);
        // The user may have moved on while the page got ready.
        if (!runsHere(p, live.current.host.place)) return;
        const steps = candidates.filter((s, i) => !s.optional || elsewhere(i) || present(s));
        if (steps.length === 0) return;
        blurFocus();
        setActive({ tour, steps, index: 0 });
      } finally {
        startingRef.current = null;
        setStarting(null);
      }
    },
    [ctx, plan, registry],
  );

  const finish = useCallback(
    (result: OnboardingOutcome) => {
      const a = activeRef.current;
      if (!a) return;
      setActive(null);
      lastEnded.current = placeKeyRef.current;
      void record([{ tour: a.tour.id, tourVersion: a.tour.version, outcome: result }]);
    },
    [record],
  );

  // Start what should start here: a replay that just arrived, the page's own tutorial, or an idle
  // one on a page with nothing of its own to show.
  const autoStart = state.welcomeSeen && state.tutorialsEnabled;
  useEffect(() => {
    if (!state.loaded || !state.welcomeSeen || !gateOpen || active || starting) return;
    const moved = navigated.current || placeKey !== firstKey.current;
    if (queued) {
      const tour = TOUR_BY_ID[queued.id];
      const p = plan(tour);
      if (p.startsOn === "idle" || p.startsOn.includes(place)) {
        setQueued(null);
        void start(tour);
        return;
      }
      const t = setTimeout(() => setQueued((q) => (q === queued ? null : q)), Math.max(0, queued.at + QUEUE_TIMEOUT_MS - Date.now()));
      return () => clearTimeout(t);
    }
    if (!autoStart || lastEnded.current === placeKey) return;
    const own = TOURS.find((t) => {
      const p = plan(t);
      return p.startsOn !== "idle" && p.startsOn.includes(place) && (!p.afterMoving || moved) && isPending(t);
    });
    if (own) {
      const t = setTimeout(() => void start(own), START_DELAY_MS);
      return () => clearTimeout(t);
    }
    // Nothing of the page's own is pending (that was started above), so an idle one may start.
    const idle = TOURS.find((t) => plan(t).startsOn === "idle" && isPending(t));
    if (idle && moved && place !== "settings") {
      const t = setTimeout(() => void start(idle), START_DELAY_MS * 2);
      return () => clearTimeout(t);
    }
  }, [state.loaded, state.welcomeSeen, autoStart, gateOpen, active, starting, queued, place, placeKey, isPending, plan, start]);

  // Leaving the tutorial's pages ends it, unsettled: it shows again next time.
  useEffect(() => {
    const a = activeRef.current;
    if (a && !runsHere(plan(a.tour), place)) setActive(null);
    // Moving on also clears the way for the next page's tutorial.
    if (lastEnded.current !== placeKey) lastEnded.current = null;
    if (placeKey !== firstKey.current) navigated.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeKey]);

  // Stepping: a step that opens somewhere else goes there first, and stepping back out of it
  // comes back.
  const next = useCallback(() => {
    const a = activeRef.current;
    if (!a || a.index >= a.steps.length - 1) return;
    a.steps[a.index + 1].go?.(ctx);
    setActive({ ...a, index: a.index + 1 });
  }, [ctx]);
  const back = useCallback(() => {
    const a = activeRef.current;
    if (!a || a.index === 0) return;
    if (a.steps[a.index].go) ctx.back();
    setActive({ ...a, index: a.index - 1 });
  }, [ctx]);

  const choose = useCallback(
    async (choice: TourChoice) => {
      const a = activeRef.current;
      if (!a || busy) return;
      setBusy(true);
      try {
        await choice.run?.(ctx);
      } catch {
        // Nothing added to the page; the tutorial still moves on.
      } finally {
        setBusy(false);
      }
      if (a.index >= a.steps.length - 1) finish("completed");
      else next();
    },
    [busy, ctx, finish, next],
  );

  const replay = useCallback(
    (id: TourId) => {
      setActive(null);
      plan(TOUR_BY_ID[id]).open(ctx);
      setQueued({ id, at: Date.now() });
    },
    [ctx, plan],
  );

  const { reset } = state;
  const resetAll = useCallback(() => reset(TOURS.map((t) => t.id)), [reset]);

  const step = active ? active.steps[active.index] : null;
  // A tutorial that opens on the sidebar holds it open as it starts, so its first step finds it.
  const holdRail = !!step?.rail || !!(starting && plan(starting).steps[0]?.rail);
  // A starting tutorial already needs its first step's state: that is where it looks for anchors.
  const view = (step ? step.view : starting ? plan(starting).steps[0]?.view : undefined) ?? null;

  const value = useMemo<OnboardingController>(
    () => ({
      tours: TOURS.map((tour) => {
        const p = plan(tour);
        return { tour, status: outcome(tour.id, tour.version) ?? "new", available: !p.available || p.available(ctx) };
      }),
      replay,
      resetAll,
      holdRail,
      view,
    }),
    // The sidebar decides whether the area and project pages can be toured.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [outcome, replay, resetAll, holdRail, view, plan, projects.sidebar],
  );

  return (
    <AnchorRegistryContext.Provider value={registry}>
      <OnboardingContext.Provider value={value}>
        {children}
        {active ? (
          <TourOverlay
            registry={registry}
            tour={active.tour}
            steps={active.steps}
            index={active.index}
            busy={busy}
            insets={host.insets}
            onNext={next}
            onBack={back}
            onSkip={() => finish("skipped")}
            onDone={() => finish("completed")}
            onChoice={(c) => void choose(c)}
            onAction={() => {
              const action = active.steps[active.index].action;
              finish("completed");
              action?.run(ctx);
            }}
          />
        ) : null}
      </OnboardingContext.Provider>
    </AnchorRegistryContext.Provider>
  );
}
