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
  docOfRef,
  keyOfRef,
  locationOfRef,
  useNav,
  viewOfRef,
  type DocRef,
  type Navigator,
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
import { ChatsScreen } from "./ChatScreen";
import { DndProvider, useDnd } from "./DndContext";
import { MultiSelectProvider } from "./MultiSelectProvider";
import { SettingsScreen } from "./SettingsScreen";
import { useSync } from "./SyncProvider";
import { SyncHealthBanner } from "./SyncHealthBanner";
import { CaptureForm } from "./CaptureForm";
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
        calendar: "calendar",
        // notes/tasks are the workspace browse lists; the active tab's open document is
        // carried in the URL (/notes/:id, /tasks/:id) so it's bookmarkable. Other open tabs
        // stay session-only.
        notes: "notes/:id?",
        tasks: "tasks/:id?",
        canvases: "canvases/:id?",
        habits: "habits",
        graph: "graph",
        trash: "trash",
        settings: "settings",
        notifications: "notifications",
        // Deep-linkable project drill-down: /project/<id>[/<section>[/<itemId>[/<subItemId>]]].
        // The fourth segment is the task selected inside a list (/lists/<listId>/<taskId>).
        project: "project/:projectId/:section?/:itemId?/:subItemId?",
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
  return { kind: "view", view: route.name as SurfaceViewId, date: route.name === "today" ? p.date : undefined };
}

/** The route that mirrors a tab's contents into the URL. */
function routeOfRef(ref: TabRef): { name: string; params?: RouteParams } {
  switch (ref.kind) {
    case "browse":
      return { name: ref.section };
    case "view":
      return ref.date ? { name: ref.view, params: { date: ref.date } } : { name: ref.view };
    case "project":
      return { name: "project", params: { projectId: ref.projectId, section: ref.section, itemId: ref.itemId, subItemId: ref.subItemId } };
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
    };
  }, [tabs, active, activeTab, activeRef, selectRef, stepTab]);

  return (
    <NavContext.Provider value={nav}>
      <ReminderNavigationBridge />
      <ThingsImportHost />
      <MultiSelectProvider>
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
        <Nav.Screen name="trash" component={RouteAnchor} />
        <Nav.Screen name="settings" component={RouteAnchor} />
        <Nav.Screen name="notifications" component={RouteAnchor} />
        <Nav.Screen name="project" component={RouteAnchor} />
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
  const [captureOpen, setCaptureOpen] = useState(false);
  // Per-device tool hiding (Settings › Tools): only the rail entry disappears — the view
  // itself stays reachable. Trash sits with Settings at the foot of the rail.
  const { tools, hidden } = useToolVisibility();
  const visibleTools = tools.filter((t) => !hidden.has(t.id));
  const rail = visibleTools.filter((t) => t.id !== "trash");
  const showTrash = visibleTools.some((t) => t.id === "trash");
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = usePersistentBoolean("companion.sidebar.pinned", false);
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
  // collapsed rail — push the toolbar (and the sync banner above it) past their right
  // edge. Nothing to do once the rail is open, or on platforms with a native titlebar.
  const chromeInset = windowControls ? Math.max(0, windowControls.left - railWidth) : 0;
  // And line the toolbar up with them vertically: pad it so its row is centred on the
  // lights, mirrored below so the content panel gets the same breathing room.
  const toolbarInset = windowControls
    ? Math.max(0, Math.round((windowControls.top + windowControls.bottom) / 2 - layout.toolbarH / 2))
    : 0;
  const activeProjectId = nav.current.kind === "project" ? nav.current.projectId : null;

  // Sync on navigation (§5.4). Key on the active tab's contents so every move fires.
  // Depend on the stable `trigger`, not the whole `sync` object: `sync` is a memo that
  // changes identity on every status/lastSyncedAt update, so listing it here would
  // re-fire this effect after each sync and loop (a sync every ~second).
  const locKey = keyOfRef(nav.activeTab.ref);
  const syncTrigger = sync.trigger;
  useEffect(() => {
    syncTrigger();
  }, [locKey, syncTrigger]);

  // Window-level shortcuts: ⌘T new tab, ⌥⇧Space quick capture. (A browser keeps ⌘T for
  // itself; the desktop shell delivers it.)
  const addTab = nav.addTab;
  useEffect(() => {
    if (typeof window === "undefined" || !window.addEventListener) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" && e.altKey && e.shiftKey) {
        e.preventDefault();
        setCaptureOpen((c) => !c);
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
                onDeleteArea={setDeletingArea}
              />
            ) : null}
            {/* Empty rail space fills the column (a window drag handle on desktop). */}
            <View style={{ flexGrow: 1, minHeight: space.lg }} />
          </ScrollView>

          <View style={{ gap: 1, paddingTop: space.sm }}>
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
          {/* Sync health: prompts re-auth / unlock in Settings when sync is blocked (§7). */}
          <SyncHealthBanner onOpenSettings={() => nav.goView("settings")} leftInset={chromeInset} />
          <Frame toolbar={<AppToolbar onCapture={() => setCaptureOpen(true)} leftInset={chromeInset} verticalInset={toolbarInset} />}>
            {/* Every tab's surface stays mounted and only the active one is shown, so an
                editor's draft, a chat's scroll or a graph's layout survives a tab switch. */}
            {nav.tabs.map((tab, i) => (
              <TabSurface key={tab.uid} tab={tab} visible={i === nav.activeIndex} />
            ))}
          </Frame>
        </View>
      </View>

      <ShellStatusBar tabCount={nav.tabs.length} />

      {captureOpen ? <QuickCapture onClose={() => setCaptureOpen(false)} /> : null}

      {deletingArea ? (
        <ConfirmDialog
          title="Delete area?"
          message={`Delete the area “${deletingArea.name}”? It has no projects, so nothing else is affected.`}
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
  trash: TrashScreen,
  settings: SettingsScreen,
  notifications: NotificationsRouteScreen,
};

function SurfaceBody({ tabRef }: { tabRef: TabRef | null }) {
  if (!tabRef) return <EmptyTab />;
  if (tabRef.kind === "project") return <ProjectView key={tabRef.projectId} />;
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
 * knows about itself. All 11px mono — none of it is the user's writing. */
function ShellStatusBar({ tabCount }: { tabCount: number }) {
  const sync = useSync();
  // Re-render on a slow tick so "synced 12s ago" stays honest without a sync event.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  const state = !sync.connected
    ? { color: colors.textQuaternary, label: "local only" }
    : sync.status === "syncing"
      ? { color: colors.accent, label: "syncing…" }
      : sync.status === "locked"
        ? { color: colors.danger, label: "locked" }
        : sync.status === "error" || sync.needsReauth
          ? { color: colors.danger, label: sync.needsReauth ? "signed out" : "sync error" }
          : { color: colors.success, label: sync.lastSyncedAt ? `synced ${agoLabel(sync.lastSyncedAt)} ago` : "connected" };

  return (
    <StatusBar>
      <View style={[styles.statusDot, { backgroundColor: state.color }]} />
      <StatusText>{state.label}</StatusText>
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

/** Quick capture (⌥⇧Space): a 460px overlay on the scrim, 14vh from the top. Esc closes. */
function QuickCapture({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    if (typeof window === "undefined" || !window.addEventListener) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <View style={styles.captureLayer}>
      <Pressable style={styles.captureScrim} onPress={onClose} aria-label="Close quick capture" />
      <View style={styles.capturePanel}>
        <CaptureForm onClose={onClose} />
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
    width: 460,
    maxWidth: "92%",
    marginTop: "14vh" as unknown as number,
    padding: space.lg,
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
