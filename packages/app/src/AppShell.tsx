import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import {
  NavigationContainer,
  StackActions,
  StackRouter,
  createNavigatorFactory,
  useNavigationBuilder,
  type LinkingOptions,
  type ParamListBase,
} from "@react-navigation/native";
import {
  BrandMark,
  Center,
  Divider,
  Frame,
  Icon,
  IconButton,
  Kbd,
  RailItem,
  Row,
  StatusBar,
  StatusText,
  Text,
  Wordmark,
  colors,
  dragRegion,
  icon,
  layout,
  motion,
  radius,
  shadow,
  space,
  transition,
  type IconName,
} from "@companion/design-system";
import type { SidebarArea } from "@companion/core-bridge";
import {
  NavContext,
  SECTION_OF,
  containerOfLocation,
  docOfRef,
  keyOfRef,
  locationOfRef,
  useNav,
  viewOfRef,
  type DocRef,
  type Navigator,
  type AreaSection,
  type ProjectSection,
  type SurfaceViewId,
  type Tab,
  type TabRef,
  type WorkspaceSection,
} from "./nav-context";
import { useCore } from "./CoreContext";
import { setReminderActivationHandler } from "./reminderNav";
import { openFocusWindow } from "./focus";
import { NotesProvider, useNotes } from "./NotesProvider";
import { TasksProvider, useTasks } from "./TasksProvider";
import { ListsProvider } from "./ListsProvider";
import { CanvasesProvider } from "./canvas/CanvasesProvider";
import { RemindersProvider, type NotificationScheduler } from "./RemindersProvider";
import { NotificationsProvider } from "./NotificationsProvider";
import { NotificationsScreen } from "./NotificationsScreen";
import { ToolVisibilityProvider, useToolVisibility, type ToolsStorage } from "./ToolVisibilityProvider";
import { ProjectsProvider, useProjects } from "./ProjectsProvider";
import { ObjectTypesProvider } from "./ObjectTypesProvider";
import { ProjectsSidebar } from "./ProjectsSidebar";
import { ConfirmDialog } from "./ConfirmDialog";
import { ProjectView } from "./ProjectView";
import { AppToolbar } from "./AppToolbar";
import { WorkspaceScreen } from "./WorkspaceScreen";
import { TodayScreen } from "./TodayScreen";
import { GraphScreen } from "./GraphScreen";
import { CalendarScreen } from "./CalendarScreen";
import { CalendarProvider } from "./CalendarProvider";
import { TrashScreen } from "./TrashScreen";
import { LogbookScreen } from "./LogbookScreen";
import { ChatsScreen } from "./ChatScreen";
import { DndProvider, useDnd } from "./DndContext";
import { MultiSelectProvider, useMultiSelect } from "./MultiSelectProvider";
import { useExportScope } from "./export/ExportProvider";
import { EXPORT_SCHEDULE_EVENT, REQUEST_SECTION, requestScheduledExport, type ExportRequestKind } from "./export/scheduling";
import { SettingsScreen } from "./SettingsScreen";
import { useSync } from "./SyncProvider";
import { SyncHealthChip, syncBlocker } from "./SyncHealthBanner";
import { PushPromptBanner } from "./push/PushPromptBanner";
import { InstallGuideScreen } from "./push/InstallGuide";
import { CommandPalette, paletteEnter } from "./CommandPalette";
import { CAPTURE_NEW_EVENT, CAPTURE_NEW_KEYS, PALETTE_OPEN_EVENT } from "./capture";
import type { PaletteCreateKind } from "./paletteModel";
import { ThingsImportHost } from "./ThingsImport";

// Monotonic tab uid so React keys are stable across reorders/overwrites even when two
// tabs hold the same surface.
let tabSeq = 0;
const freshTab = (ref: TabRef | null = null): Tab => ({ uid: `tab${++tabSeq}`, ref, back: [], fwd: [] });

type PlaceholderView = "habits";

const PLACEHOLDER: Record<PlaceholderView, string> = {
  habits: "Habits, streaks, and gentle nudges are on the way.",
};

/** The box native window controls (macOS traffic lights) occupy over the page, in CSS px
 * from the window's top-left. Measured by the desktop host (apps/desktop /chrome). */
export interface WindowControls {
  left: number;
  top: number;
  bottom: number;
}

export interface AppShellProps {
  topInset?: number;
  /** Native window controls drawn over the page; the shell keeps its toolbar clear of them. */
  windowControls?: WindowControls;
  /** Per-platform reminder scheduler (PLAN §6.4); passed straight to RemindersProvider.
   *  When omitted it uses the best-effort web `Notification` scheduler. */
  notificationScheduler?: NotificationScheduler;
  /** Where per-device tool visibility persists; defaults to localStorage. */
  toolsStorage?: ToolsStorage;
}

// ---------------------------------------------------------------------------
// React Navigation is the router (routes + URL deep-linking). A custom navigator
// renders our own chrome; a thin layer on top of the router state adds open-note
// tabs and a forward-history stack (which React Navigation doesn't model natively).
// ---------------------------------------------------------------------------

/** URL linking, web only (http/https). On desktop the webview scheme varies, so nav
 * stays in-memory there — still React Navigation, just without URL sync. */
function webLinking(): LinkingOptions<ParamListBase> | undefined {
  if (typeof window === "undefined" || !/^https?:$/.test(window.location.protocol)) return undefined;
  return {
    prefixes: [window.location.origin],
    config: {
      screens: {
        // Today takes an optional day (/today/2026-07-08) so a dated note can deep-link.
        today: "today/:date?",
        chat: "chat",
        // The calendar takes an optional day too (/calendar/2026-07-08): the week to show.
        calendar: "calendar/:date?",
        // notes/tasks are the workspace browse lists; the active tab's open document is
        // carried in the URL (/notes/:id, /tasks/:id) so it's bookmarkable. Other open tabs
        // stay session-only.
        notes: "notes/:id?",
        tasks: "tasks/:id?",
        canvases: "canvases/:id?",
        habits: "habits",
        graph: "graph",
        logbook: "logbook",
        trash: "trash",
        // The open section rides in the URL (/settings/ai) — the same path the mobile shell
        // uses for its pushed section screen, so a shell swap lands on the same section.
        settings: "settings/:section?",
        notifications: "notifications",
        // The iPhone/iPad install guide (push/InstallGuide.tsx), same path as the mobile shell's.
        install: "install",
        // Deep-linkable project drill-down: /project/<id>[/<section>[/<itemId>[/<subItemId>]]].
        // The fourth segment is the task selected inside a list (/lists/<listId>/<taskId>).
        project: "project/:projectId/:section?/:itemId?/:subItemId?",
        // An area's page: /area/<id>[/<section>[/<itemId>]] (PLAN-areas.md §3).
        area: "area/:areaId/:section?/:itemId?",
      },
    },
  };
}

// Tabs own what's on screen (see Shell); the router only carries the *active* tab's
// location for URL linking + browser history. Every route renders nothing.
function RouteAnchor() {
  return null;
}

interface RouteParams {
  id?: string;
  date?: string;
  projectId?: string;
  areaId?: string;
  section?: string;
  itemId?: string;
  subItemId?: string;
}
interface RouteLike {
  key: string;
  name: string;
  params?: RouteParams;
}
interface StateLike {
  index: number;
  routes: RouteLike[];
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NavLike = any;

const DOC_KIND_OF: Record<WorkspaceSection, DocRef["kind"]> = { notes: "note", tasks: "task", canvases: "canvas" };
const isSection = (name: string): name is WorkspaceSection => name === "notes" || name === "tasks" || name === "canvases";

/** The tab contents a route describes (a bookmarked /notes/:id, /graph, /project/…). */
function refOfRoute(route: RouteLike): TabRef {
  const p = route.params ?? {};
  if (isSection(route.name)) return p.id ? { kind: DOC_KIND_OF[route.name], id: p.id } : { kind: "browse", section: route.name };
  if (route.name === "project") {
    return {
      kind: "project",
      projectId: p.projectId ?? "",
      section: p.section as ProjectSection | undefined,
      itemId: p.itemId,
      subItemId: p.subItemId,
    };
  }
  if (route.name === "area") {
    return { kind: "area", areaId: p.areaId ?? "", section: asAreaSection(p.section), itemId: p.itemId };
  }
  return {
    kind: "view",
    view: route.name as SurfaceViewId,
    date: route.name === "today" || route.name === "calendar" ? p.date : undefined,
    section: route.name === "settings" ? p.section : undefined,
  };
}

/** An area holds only notes, tasks and canvases; anything else in the URL is its overview. */
function asAreaSection(section: string | undefined): AreaSection | undefined {
  return section === "notes" || section === "tasks" || section === "canvases" ? section : undefined;
}

/** The route that mirrors a tab's contents into the URL. */
function routeOfRef(ref: TabRef): { name: string; params?: RouteParams } {
  switch (ref.kind) {
    case "browse":
      return { name: ref.section };
    case "view":
      if (ref.date) return { name: ref.view, params: { date: ref.date } };
      return ref.section ? { name: ref.view, params: { section: ref.section } } : { name: ref.view };
    case "project":
      return { name: "project", params: { projectId: ref.projectId, section: ref.section, itemId: ref.itemId, subItemId: ref.subItemId } };
    case "area":
      return { name: "area", params: { areaId: ref.areaId, section: ref.section, itemId: ref.itemId } };
    default:
      return { name: SECTION_OF[ref.kind], params: { id: ref.id } };
  }
}

function CompanionNavigator({
  initialRouteName,
  children,
  screenOptions,
  topInset,
  windowControls,
}: {
  initialRouteName?: string;
  children: ReactNode;
  screenOptions?: unknown;
  topInset: number;
  windowControls?: WindowControls;
}) {
  const { state, navigation, NavigationContent } = useNavigationBuilder(StackRouter, {
    initialRouteName,
    children,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    screenOptions: screenOptions as any,
  });
  return (
    <NavigationContent>
      <NavBridge state={state} navigation={navigation} topInset={topInset} windowControls={windowControls} />
    </NavigationContent>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createCompanionNavigator = createNavigatorFactory(CompanionNavigator as any);
const Nav = createCompanionNavigator();

/** Builds the useNav() API. Tabs are the source of truth: each holds a surface and its own
 * Back/Forward history. The router mirrors the active tab (URL + browser history) and
 * feeds deep links / browser Back into it. */
function NavBridge({
  state,
  navigation,
  topInset,
  windowControls,
}: {
  state: StateLike;
  navigation: NavLike;
  topInset: number;
  windowControls?: WindowControls;
}) {
  const route = state.routes[state.index];

  // Always ≥ 1 tab. Tabs are session state; the first is seeded from the landing route (a
  // bookmarked URL, or the user's first visible tool).
  const [tabs, setTabs] = useState<Tab[]>(() => [freshTab(refOfRoute(route))]);
  const [activeIndex, setActiveIndex] = useState(0);

  const active = Math.min(activeIndex, tabs.length - 1);
  const activeTab = tabs[active];
  const activeRef = activeTab.ref;

  // Point the active tab at a surface, remembering the one it replaces for per-tab Back.
  const selectRef = useCallback(
    (ref: TabRef) => {
      setTabs((ts) =>
        ts.map((tab, i) => {
          if (i !== active || keyOfRef(tab.ref) === keyOfRef(ref)) return tab;
          return { ...tab, ref, back: tab.ref ? [...tab.back, tab.ref] : tab.back, fwd: [] };
        }),
      );
    },
    [active],
  );

  // Point the active tab at a surface *in place of* what it holds: the outgoing surface is
  // not remembered, and any earlier visit to it is dropped from this tab's history. How a
  // deleted document is left behind — the tab falls back to its browse list, and Back never
  // returns to the tombstone.
  const replaceRef = useCallback(
    (ref: TabRef) => {
      setTabs((ts) =>
        ts.map((tab, i) => {
          if (i !== active) return tab;
          const gone = keyOfRef(tab.ref);
          const without = (stack: TabRef[]) => stack.filter((r) => keyOfRef(r) !== gone);
          const back = without(tab.back);
          const fwd = without(tab.fwd);
          // Landing on the surface this tab came from (the list the deleted note was picked
          // from) is a step back, not a new one: consume that entry instead of leaving a
          // Back button that goes nowhere.
          if (back.length && keyOfRef(back[back.length - 1]) === keyOfRef(ref)) back.pop();
          return { ...tab, ref, back, fwd };
        }),
      );
    },
    [active],
  );

  // Restore a surface from the active tab's Back (dir -1) or Forward (dir +1) stack.
  const stepTab = useCallback(
    (dir: -1 | 1) => {
      setTabs((ts) =>
        ts.map((t, i) => {
          if (i !== active) return t;
          const from = dir === -1 ? t.back : t.fwd;
          if (!from.length) return t;
          const target = from[from.length - 1];
          return dir === -1
            ? { ...t, ref: target, back: t.back.slice(0, -1), fwd: t.ref ? [...t.fwd, t.ref] : t.fwd }
            : { ...t, ref: target, fwd: t.fwd.slice(0, -1), back: t.ref ? [...t.back, t.ref] : t.back };
        }),
      );
    },
    [active],
  );

  // Keep the router and the active tab in step. Whichever moved last wins:
  //  - the tab moved (a selection, a rail click, a tab switch) → mirror it into the URL.
  //    Navigating within a tab pushes, so browser Back works; switching tabs replaces.
  //  - the route moved (browser Back/Forward, a deep link) → feed it to the active tab,
  //    walking its own history when the target is simply the previous/next surface.
  const routeKey = keyOfRef(refOfRoute(route));
  const refKey = keyOfRef(activeRef);
  const prev = useRef({ routeKey, refKey, uid: activeTab.uid });
  useEffect(() => {
    const p = prev.current;
    prev.current = { routeKey, refKey, uid: activeTab.uid };
    if (routeKey === refKey) return;
    if (refKey !== p.refKey || activeTab.uid !== p.uid) {
      if (!activeRef) return; // an empty tab has no URL of its own
      const r = routeOfRef(activeRef);
      navigation.dispatch(activeTab.uid !== p.uid ? StackActions.replace(r.name, r.params) : StackActions.push(r.name, r.params));
    } else if (routeKey !== p.routeKey) {
      const top = (stack: TabRef[]) => (stack.length ? keyOfRef(stack[stack.length - 1]) : null);
      if (top(activeTab.back) === routeKey) stepTab(-1);
      else if (top(activeTab.fwd) === routeKey) stepTab(1);
      else selectRef(refOfRoute(route));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey, refKey, activeTab.uid]);

  const nav = useMemo<Navigator>(() => {
    // Close a tab, keeping at least one (empty) slot and a valid active index.
    const removeTab = (index: number) => {
      if (tabs.length <= 1) {
        setTabs([freshTab()]);
        setActiveIndex(0);
        return;
      }
      setTabs((t) => t.filter((_, i) => i !== index));
      setActiveIndex((cur) => (index < cur ? cur - 1 : index === cur ? Math.min(cur, tabs.length - 2) : cur));
    };
    return {
      current: locationOfRef(activeRef),
      activeView: viewOfRef(activeRef),
      visible: true,
      // Back/Forward walk the active tab's own history, like a browser tab.
      canBack: activeTab.back.length > 0,
      canForward: activeTab.fwd.length > 0,
      back: () => stepTab(-1),
      forward: () => stepTab(1),
      // A rail click points the *active* tab at that surface. A workspace section opens its
      // browse list with nothing selected — unless the tab is already in that section.
      goView: (view) => {
        if (isSection(view)) {
          if (viewOfRef(activeRef) !== view) selectRef({ kind: "browse", section: view });
        } else selectRef({ kind: "view", view });
      },

      tabs,
      activeIndex: active,
      activeTab,
      openNote: (id) => selectRef({ kind: "note", id }),
      openTask: (id) => selectRef({ kind: "task", id }),
      openCanvas: (id) => selectRef({ kind: "canvas", id }),
      openRef: selectRef,
      replaceRef,
      openInNewTab: (ref) => {
        // Append a tab already holding the surface and focus it, in one shot.
        setTabs((t) => [...t, freshTab(ref)]);
        setActiveIndex(tabs.length);
      },
      addTab: () => {
        setActiveIndex(tabs.length);
        setTabs((t) => [...t, freshTab()]);
      },
      selectTab: (index) => setActiveIndex(index),
      closeTab: (index) => removeTab(index),
      expandTab: (index) => {
        // Only notes and tasks have a focus window; anything else just stays put.
        const doc = docOfRef(tabs[index]?.ref ?? null);
        if (!doc || doc.kind === "canvas") return;
        openFocusWindow(doc.kind, doc.id);
        removeTab(index);
      },

      // Each level of the project drill-down is a step in the tab's history, so Back pops
      // item ← section ← overview and the URL stays deep-linkable.
      openProject: (projectId) => selectRef({ kind: "project", projectId }),
      openProjectSection: (projectId, section) => selectRef({ kind: "project", projectId, section }),
      openProjectItem: (projectId, section, itemId) => selectRef({ kind: "project", projectId, section, itemId }),
      // A task selected inside a list: the list stays the column's item, the task is the detail.
      openProjectSubItem: (projectId, section, itemId, subItemId) =>
        selectRef({ kind: "project", projectId, section, itemId, subItemId }),
      openArea: (areaId) => selectRef({ kind: "area", areaId }),
      openContainer: (container, section, itemId) =>
        selectRef(
          container.kind === "area"
            ? { kind: "area", areaId: container.id, section: asAreaSection(section), itemId: asAreaSection(section) ? itemId : undefined }
            : { kind: "project", projectId: container.id, section, itemId },
        ),
    };
  }, [tabs, active, activeTab, activeRef, selectRef, replaceRef, stepTab]);

  return (
    <NavContext.Provider value={nav}>
      <ReminderNavigationBridge />
      <PaletteNavigationBridge />
      <ThingsImportHost />
      <ExportScheduleBridge />
      <MultiSelectProvider>
        <ExportScope />
        <DndProvider>
          <Shell topInset={topInset} windowControls={windowControls} />
        </DndProvider>
      </MultiSelectProvider>
    </NavContext.Provider>
  );
}

/** Bridges a tapped reminder to navigation (PLAN §6.4). Mounted inside the navigator so it
 *  can drive it. Two triggers converge here: the web `Notification` onclick (via the shared
 *  activateReminder registry) and the desktop shell's native tap, relayed from the Go side
 *  as a `notify.activate` core event over the bridge's event stream. */
function ReminderNavigationBridge() {
  const nav = useNav();
  const { core } = useCore();
  useEffect(() => {
    const open = (taskId: string) => {
      if (!taskId) return;
      nav.openTask(taskId);
    };
    setReminderActivationHandler(({ taskId }) => open(taskId));
    const off = core.on("notify.activate", (payload) => {
      const taskId = (payload as { taskId?: string } | null)?.taskId;
      if (taskId) open(taskId);
    });
    return () => {
      setReminderActivationHandler(null);
      off();
    };
  }, [nav, core]);
  return null;
}

/** The desktop's File › Export › Schedule Filesystem Exports… and Git Sync…, and File › Import ›
 *  Markdown Files…: open the settings section each belongs to and start it there (the section
 *  takes the request once it mounts). */
function ExportScheduleBridge() {
  const nav = useNav();
  const { core } = useCore();
  useEffect(
    () =>
      core.on(EXPORT_SCHEDULE_EVENT, (payload) => {
        const kind = (payload as { kind?: string } | null)?.kind as ExportRequestKind | undefined;
        if (!kind || !(kind in REQUEST_SECTION)) return;
        requestScheduledExport(kind);
        nav.openRef({ kind: "view", view: "settings", section: REQUEST_SECTION[kind] });
      }),
    [nav, core],
  );
  return null;
}

/** Tells the desktop's File › Export what it would export here: the multiselection while one is
 *  active, else the document the active tab shows (a note, a task or a canvas — also one selected
 *  inside a project or an area). */
function ExportScope() {
  const nav = useNav();
  const ms = useMultiSelect();
  const doc = docOfRef(nav.activeTab.ref);
  useExportScope(ms.active ? ms.selectedIds.map((id) => ({ kind: ms.kind, id })) : doc ? [doc] : null);
  return null;
}

/** Show a palette result: the tab already holding it if there is one, else the active tab —
 *  or, asked for a new tab (⇧⏎), one of its own. */
function revealRef(nav: Navigator, ref: TabRef, newTab = false) {
  if (newTab) return nav.openInNewTab(ref);
  const held = nav.tabs.findIndex((t) => keyOfRef(t.ref) === keyOfRef(ref));
  if (held >= 0) nav.selectTab(held);
  else nav.openRef(ref);
}

/** Shows what the quick-capture window's palette asked for. That window is a webview of its
 *  own, so the desktop shell brings this one forward and relays the chosen TabRef as a
 *  `palette.open` event on the core's event stream. */
function PaletteNavigationBridge() {
  const nav = useNav();
  const { core } = useCore();
  useEffect(
    () =>
      core.on(PALETTE_OPEN_EVENT, (payload) => {
        // The ref, with the capture window's `newTab` (⇧⏎) riding along beside its own fields.
        const { newTab, ...ref } = (payload ?? {}) as TabRef & { newTab?: boolean };
        if ("kind" in ref) revealRef(nav, ref as TabRef, newTab === true);
      }),
    [nav, core],
  );
  return null;
}

export function AppShell({ topInset = 0, windowControls, notificationScheduler, toolsStorage }: AppShellProps) {
  return (
    <ToolVisibilityProvider storage={toolsStorage}>
    <NotesProvider>
      <TasksProvider>
       <RemindersProvider scheduler={notificationScheduler}>
        <NotificationsProvider>
        <ProjectsProvider>
         <ListsProvider>
         <CanvasesProvider>
         <ObjectTypesProvider>
          <CalendarProvider>
          <ShellRoutes topInset={topInset} windowControls={windowControls} />
          </CalendarProvider>
         </ObjectTypesProvider>
         </CanvasesProvider>
         </ListsProvider>
        </ProjectsProvider>
        </NotificationsProvider>
       </RemindersProvider>
      </TasksProvider>
    </NotesProvider>
    </ToolVisibilityProvider>
  );
}

/** The router + screens. Lives under ToolVisibilityProvider so a fresh landing (no URL
 * path to restore) starts on the user's first *visible* tool, not a hardcoded section.
 * Settings is the fallback — it's the one view that can't be hidden. */
function ShellRoutes({ topInset, windowControls }: { topInset: number; windowControls?: WindowControls }) {
  const linking = useMemo(webLinking, []);
  const { tools, hidden } = useToolVisibility();
  const initialRoute = tools.find((t) => !hidden.has(t.id))?.id ?? "settings";
  return (
    <NavigationContainer linking={linking} documentTitle={{ enabled: false }}>
      <Nav.Navigator initialRouteName={initialRoute} topInset={topInset} windowControls={windowControls}>
        <Nav.Screen name="today" component={RouteAnchor} />
        <Nav.Screen name="chat" component={RouteAnchor} />
        <Nav.Screen name="calendar" component={RouteAnchor} />
        <Nav.Screen name="notes" component={RouteAnchor} />
        <Nav.Screen name="tasks" component={RouteAnchor} />
        <Nav.Screen name="canvases" component={RouteAnchor} />
        <Nav.Screen name="habits" component={RouteAnchor} />
        <Nav.Screen name="graph" component={RouteAnchor} />
        <Nav.Screen name="logbook" component={RouteAnchor} />
        <Nav.Screen name="trash" component={RouteAnchor} />
        <Nav.Screen name="settings" component={RouteAnchor} />
        <Nav.Screen name="notifications" component={RouteAnchor} />
        <Nav.Screen name="install" component={RouteAnchor} />
        <Nav.Screen name="project" component={RouteAnchor} />
        <Nav.Screen name="area" component={RouteAnchor} />
      </Nav.Navigator>
    </NavigationContainer>
  );
}

/** The persistent chrome: a hover-reveal rail beside an inset Frame (toolbar with the tab
 * strip over the content panel), and a mono status bar spanning the window beneath both. */
function Shell({ topInset, windowControls }: { topInset: number; windowControls?: WindowControls }) {
  const nav = useNav();
  const sync = useSync();
  const dnd = useDnd();
  const notes = useNotes();
  const tasks = useTasks();
  const { deleteArea } = useProjects();
  // The area pending deletion — its confirm dialog is rendered at the shell root, outside
  // the clipped (overflow:hidden) rail so the scrim can cover the whole window.
  const [deletingArea, setDeletingArea] = useState<SidebarArea | null>(null);
  // Quick capture: closed, open on its command list ("list"), or open straight on New note /
  // task / canvas (⌥⇧N / T / C, or the desktop File menu).
  const [capture, setCapture] = useState<PaletteCreateKind | "list" | null>(null);
  const { core } = useCore();
  useEffect(
    () =>
      core.on(CAPTURE_NEW_EVENT, (payload) => {
        const what = (payload as { what?: string } | null)?.what;
        if (what === "note" || what === "task" || what === "canvas") setCapture(what);
      }),
    [core],
  );
  // Per-device tool hiding (Settings › Tools): only the rail entry disappears — the view
  // itself stays reachable. The Logbook and the Trash sit with Settings at the foot of the rail.
  const { tools, hidden } = useToolVisibility();
  const visibleTools = tools.filter((t) => !hidden.has(t.id));
  const rail = visibleTools.filter((t) => t.id !== "trash" && t.id !== "logbook");
  const showTrash = visibleTools.some((t) => t.id === "trash");
  const showLogbook = visibleTools.some((t) => t.id === "logbook");
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = usePersistentBoolean("companion.sidebar.pinned", true);
  // Reveal the rail while a dragged document approaches it, so projects become drop
  // targets — but not on every drag: a note dragged onto a board in the content area
  // shouldn't shove the layout sideways. Hysteresis: expand within the collapsed rail's
  // width (plus a margin), collapse once the pointer leaves the expanded rail.
  const [dragNearRail, setDragNearRail] = useState(false);
  useEffect(() => {
    if (!dnd.dragging) {
      setDragNearRail(false);
      return;
    }
    return dnd.subscribeMove((x) => {
      setDragNearRail((prev) => {
        const near = x < (prev ? layout.railOpenW + 16 : layout.railW + 12);
        return near === prev ? prev : near;
      });
    });
  }, [dnd.dragging, dnd.subscribeMove]);
  // The rail's width transition takes ~200ms; re-measure the project targets once it lands.
  useEffect(() => {
    if (!dragNearRail) return;
    const t = setTimeout(() => void dnd.remeasure(), motion.medium + 60);
    return () => clearTimeout(t);
  }, [dragNearRail, dnd.remeasure]);
  const expanded = open || pinned || dragNearRail;
  const railWidth = expanded ? layout.railOpenW : layout.railW;
  // macOS traffic lights sit over the rail's padded top, but they're wider than the
  // collapsed rail — push the toolbar past their right edge. Nothing to do once the
  // rail is open, or on platforms with a native titlebar.
  const chromeInset = windowControls ? Math.max(0, windowControls.left - railWidth) : 0;
  // And line the toolbar up with them vertically: pad it so its row is centred on the
  // lights, mirrored below so the content panel gets the same breathing room.
  const toolbarInset = windowControls
    ? Math.max(0, Math.round((windowControls.top + windowControls.bottom) / 2 - layout.toolbarH / 2))
    : 0;
  const activeProjectId = nav.current.kind === "project" ? nav.current.projectId : null;
  const activeAreaId = nav.current.kind === "area" ? nav.current.areaId : null;

  // Sync on navigation (§5.4). Key on the active tab's contents so every move fires.
  // Depend on the stable `trigger`, not the whole `sync` object: `sync` is a memo that
  // changes identity on every status/lastSyncedAt update, so listing it here would
  // re-fire this effect after each sync and loop (a sync every ~second).
  const locKey = keyOfRef(nav.activeTab.ref);
  const syncTrigger = sync.trigger;
  useEffect(() => {
    syncTrigger();
  }, [locKey, syncTrigger]);

  // Window-level shortcuts: ⌘T new tab, ⌥⇧Space quick capture, ⌥⇧N / T / C a new note / task /
  // canvas. (A browser keeps ⌘T for itself; the desktop shell delivers it — and its File menu
  // owns the ⌥⇧ letters there, arriving as CAPTURE_NEW_EVENT instead.)
  const addTab = nav.addTab;
  useEffect(() => {
    if (typeof window === "undefined" || !window.addEventListener) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" && e.altKey && e.shiftKey) {
        e.preventDefault();
        setCapture((c) => (c ? null : "list"));
      } else if (e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey && CAPTURE_NEW_KEYS[e.code]) {
        e.preventDefault();
        setCapture(CAPTURE_NEW_KEYS[e.code]);
      } else if ((e.key === "t" || e.key === "T") && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        addTab();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [addTab]);

  // Sidebar badges count what needs sorting: notes in no project, and open tasks in no project.
  const badgeFor = (id: string) =>
    id === "notes" ? countLabel(notes.unsorted.length) : id === "tasks" ? countLabel(tasks.openUnsorted.length) : undefined;
  const railIcon = (name: IconName, id: string) => (
    <Icon name={name} size={icon.lg} color={nav.activeView === id ? colors.textAccent : colors.textSecondary} />
  );

  return (
    <View style={styles.window}>
      <View style={styles.body}>
        <View
          onPointerEnter={() => setOpen(true)}
          onPointerLeave={() => setOpen(false)}
          style={[
            dragRegion,
            styles.rail,
            { width: railWidth, paddingTop: space.md + topInset },
            transition("width", motion.medium),
          ]}
        >
          <View style={styles.railHeader}>
            {expanded ? (
              <>
                <Wordmark size={18} />
                <View style={{ flex: 1 }} />
                <IconButton label={pinned ? "Unpin sidebar" : "Pin sidebar"} size="sm" active={pinned} onPress={() => setPinned((p) => !p)}>
                  <Icon name="panelLeft" size={13} color={pinned ? colors.textAccent : colors.textSecondary} />
                </IconButton>
              </>
            ) : (
              <BrandMark size={18} />
            )}
          </View>

          <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ flexGrow: 1 }}>
            <View style={{ gap: 1 }}>
              {rail.map((n) => (
                <RailItem
                  key={n.id}
                  icon={railIcon(n.icon, n.id)}
                  label={n.label}
                  badge={badgeFor(n.id)}
                  active={nav.activeView === n.id}
                  expanded={expanded}
                  onPress={() => nav.goView(n.id)}
                />
              ))}
            </View>
            {/* Areas → projects tree, only when there's room to render labels. */}
            {expanded ? (
              <ProjectsSidebar
                onSelectProject={nav.openProject}
                activeProjectId={activeProjectId}
                onSelectArea={nav.openArea}
                activeAreaId={activeAreaId}
                onDeleteArea={setDeletingArea}
              />
            ) : null}
            {/* Empty rail space fills the column (a window drag handle on desktop). */}
            <View style={{ flexGrow: 1, minHeight: space.lg }} />
          </ScrollView>

          <View style={{ gap: 1, paddingTop: space.sm }}>
            {showLogbook ? (
              <RailItem
                icon={railIcon("logbook", "logbook")}
                label="Logbook"
                active={nav.activeView === "logbook"}
                expanded={expanded}
                onPress={() => nav.goView("logbook")}
              />
            ) : null}
            {showTrash ? (
              <RailItem
                icon={railIcon("trash", "trash")}
                label="Trash"
                active={nav.activeView === "trash"}
                expanded={expanded}
                onPress={() => nav.goView("trash")}
              />
            ) : null}
            <RailItem
              icon={railIcon("settings", "settings")}
              label="Settings"
              active={nav.activeView === "settings"}
              expanded={expanded}
              onPress={() => nav.goView("settings")}
            />
          </View>
        </View>

        <View style={{ flex: 1, minWidth: 0 }}>
          {/* iPad Safari in landscape lands here: offer installing to the Home Screen. */}
          <PushPromptBanner leftInset={chromeInset} />
          <Frame toolbar={<AppToolbar onCapture={() => setCapture("list")} leftInset={chromeInset} verticalInset={toolbarInset} />}>
            {/* Every tab's surface stays mounted and only the active one is shown, so an
                editor's draft, a chat's scroll or a graph's layout survives a tab switch. */}
            {nav.tabs.map((tab, i) => (
              <TabSurface key={tab.uid} tab={tab} visible={i === nav.activeIndex} />
            ))}
          </Frame>
        </View>
      </View>

      <ShellStatusBar tabCount={nav.tabs.length} />

      {capture ? <QuickCapture key={capture} what={capture === "list" ? null : capture} onClose={() => setCapture(null)} /> : null}

      {deletingArea ? (
        <ConfirmDialog
          title="Delete area?"
          message={`Delete the area “${deletingArea.name}”? It has no projects; anything filed directly in it moves to Unsorted.`}
          confirmLabel="Delete area"
          onConfirm={async () => {
            await deleteArea(deletingArea.id);
            setDeletingArea(null);
          }}
          onClose={() => setDeletingArea(null)}
        />
      ) : null}
    </View>
  );
}

/** One tab's surface. Re-provides the nav context scoped to this tab — `current` and
 * `activeTab` describe *this* tab, and `visible` says whether it is the one on screen — so
 * a screen renders the same whether it is the active tab or parked in the background. */
function TabSurface({ tab, visible }: { tab: Tab; visible: boolean }) {
  const nav = useNav();
  const scoped = useMemo<Navigator>(
    () => ({ ...nav, current: locationOfRef(tab.ref), activeTab: tab, visible }),
    [nav, tab, visible],
  );
  return (
    <View style={[styles.surface, visible ? null : styles.hidden]}>
      <NavContext.Provider value={scoped}>
        <SurfaceBody tabRef={tab.ref} />
      </NavContext.Provider>
    </View>
  );
}

const VIEW_SCREENS: Partial<Record<SurfaceViewId, ComponentType>> = {
  today: TodayScreen,
  chat: ChatsScreen,
  calendar: CalendarScreen,
  graph: GraphScreen,
  logbook: LogbookScreen,
  trash: TrashScreen,
  settings: SettingsScreen,
  notifications: NotificationsRouteScreen,
  install: InstallGuideScreen,
};

function SurfaceBody({ tabRef }: { tabRef: TabRef | null }) {
  if (!tabRef) return <EmptyTab />;
  if (tabRef.kind === "project") return <ProjectView key={tabRef.projectId} />;
  if (tabRef.kind === "area") return <ProjectView key={tabRef.areaId} />;
  if (tabRef.kind === "view") {
    const Screen = VIEW_SCREENS[tabRef.view];
    return Screen ? <Screen /> : <ComingSoon view={tabRef.view as PlaceholderView} />;
  }
  // A document or a browse list: the workspace split. Unkeyed, so moving between notes in
  // one tab keeps the list (its scroll, its search) and only swaps the editor.
  return <WorkspaceScreen />;
}

/** A fresh tab: nothing is opened on the user's behalf. */
function EmptyTab() {
  return (
    <Center>
      <Text variant="title">Nothing selected</Text>
      <Text variant="caption" tone="tertiary">
        Pick a tool from the rail, or something from a list.
      </Text>
      <Row gap={5} align="center">
        <Kbd>⌘T</Kbd>
        <Text variant="mono" tone="quaternary">
          new tab
        </Text>
      </Row>
    </Center>
  );
}

// Adapts the navigator-free NotificationsScreen to this shell: opening an entry's task
// points the active tab at it.
function NotificationsRouteScreen() {
  const nav = useNav();
  return <NotificationsScreen onOpenTask={nav.openTask} />;
}

/** The persistent mono status strip: sync state, server, open tabs, and what the machine
 * knows about itself. All 11px mono — none of it is the user's writing. When sync needs the
 * user (unlock, or sign in again), a red chip leads it instead of the sync dot (§7). */
function ShellStatusBar({ tabCount }: { tabCount: number }) {
  const nav = useNav();
  const sync = useSync();
  // Re-render on a slow tick so "synced 12s ago" stays honest without a sync event.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  const blocker = syncBlocker(sync);
  const state = !sync.connected
    ? { color: colors.textQuaternary, label: "local only" }
    : sync.status === "syncing"
      ? { color: colors.accent, label: "syncing…" }
      : sync.status === "error"
        ? { color: colors.danger, label: "sync error" }
        : { color: colors.success, label: sync.lastSyncedAt ? `synced ${agoLabel(sync.lastSyncedAt)} ago` : "connected" };

  return (
    <StatusBar>
      {blocker ? (
        <SyncHealthChip blocker={blocker} onOpenSettings={() => nav.openRef({ kind: "view", view: "settings", section: "sync" })} />
      ) : (
        <>
          <View style={[styles.statusDot, { backgroundColor: state.color }]} />
          <StatusText>{state.label}</StatusText>
        </>
      )}
      {sync.connected && sync.baseUrl ? (
        <>
          <Divider vertical style={styles.statusDivider} />
          <StatusText>{hostOf(sync.baseUrl)}</StatusText>
        </>
      ) : null}
      <Divider vertical style={styles.statusDivider} />
      <StatusText>{tabCount === 1 ? "1 tab open" : `${tabCount} tabs open`}</StatusText>
      <View style={{ flex: 1 }} />
      <StatusText>{sync.connected && sync.encrypted ? "e2e encrypted" : "stored on this device"}</StatusText>
    </StatusBar>
  );
}

/** Quick capture (⌥⇧Space, or the toolbar's Capture): the command palette on the scrim, 14vh
 *  from the top. The palette owns its keys (Esc steps back, then closes); results open in the
 *  tab already holding them, else the active one — or, on ⇧⏎, a new one. `what` opens it
 *  straight on New note / task / canvas. Whatever is created is filed in the project or area
 *  the active tab is showing, if it is showing one. */
function QuickCapture({ what, onClose }: { what: PaletteCreateKind | null; onClose: () => void }) {
  const nav = useNav();
  const initialMode = useMemo(() => (what ? ({ kind: "create", what } as const) : undefined), [what]);
  const shown = containerOfLocation(nav.current);
  const container = useMemo(() => (shown ? { kind: shown.kind, id: shown.id } : null), [shown?.kind, shown?.id]);
  return (
    <View style={styles.captureLayer}>
      <Pressable style={styles.captureScrim} onPress={onClose} aria-label="Close quick capture" />
      <View style={[styles.capturePanel, paletteEnter]}>
        <CommandPalette onClose={onClose} onOpen={(ref, opts) => revealRef(nav, ref, opts?.newTab)} initialMode={initialMode} container={container} />
      </View>
    </View>
  );
}

function ComingSoon({ view }: { view: PlaceholderView }) {
  return (
    <Center>
      <Text tone="tertiary" variant="caption" style={{ textAlign: "center", maxWidth: 360, lineHeight: 18 }}>
        {PLACEHOLDER[view] ?? "Nothing here yet."}
      </Text>
    </Center>
  );
}

const countLabel = (n: number) => (n > 0 ? String(n) : undefined);

function agoLabel(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}

function hostOf(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
}

const styles = StyleSheet.create({
  window: { flex: 1, backgroundColor: colors.surfaceApp, overflow: "hidden" },
  body: { flex: 1, minHeight: 0, flexDirection: "row" },
  rail: { flexShrink: 0, paddingHorizontal: space.md, paddingBottom: space.md, overflow: "hidden" },
  railHeader: { flexDirection: "row", alignItems: "center", gap: space.sm, height: 24, marginBottom: space.md, paddingLeft: 5 },
  surface: { flex: 1, minHeight: 0 },
  hidden: { display: "none" },
  statusDot: { width: 5, height: 5, borderRadius: radius.full },
  statusDivider: { height: 10, alignSelf: "center" },
  captureLayer: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, alignItems: "center", zIndex: 100 },
  captureScrim: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.scrim },
  capturePanel: {
    width: 600,
    maxWidth: "92%",
    maxHeight: "72vh" as unknown as number,
    marginTop: "14vh" as unknown as number,
    overflow: "hidden",
    backgroundColor: colors.surfaceOverlay,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.xl,
    ...shadow.lg,
  },
});

function usePersistentBoolean(key: string, initial: boolean) {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const stored = globalThis.localStorage?.getItem(key);
      return stored == null ? initial : stored === "true";
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      setValue((prev) => {
        const resolved = typeof next === "function" ? next(prev) : next;
        try {
          globalThis.localStorage?.setItem(key, String(resolved));
        } catch {
          /* storage unavailable */
        }
        return resolved;
      });
    },
    [key],
  );
  return [value, set] as const;
}
