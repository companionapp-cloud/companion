import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ScrollView, View } from "react-native";
import {
  NavigationContainer,
  StackActions,
  StackRouter,
  createNavigatorFactory,
  useNavigationBuilder,
  useRoute,
  type LinkingOptions,
  type ParamListBase,
} from "@react-navigation/native";
import {
  Avatar,
  BrandMark,
  Frame,
  Icon,
  IconButton,
  RailItem,
  Text,
  colors,
  dragRegion,
  layout,
  space,
  transition,
} from "@companion/design-system";
import type { SidebarArea } from "@companion/core-bridge";
import { NavContext, useNav, type NavLocation, type Navigator, type ProjectSection, type Tab, type TabRef, type ViewId } from "./nav-context";
import { useCore } from "./CoreContext";
import { setReminderActivationHandler } from "./reminderNav";
import { openFocusWindow } from "./focus";
import { NotesProvider } from "./NotesProvider";
import { TasksProvider } from "./TasksProvider";
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

// Monotonic tab uid so React keys are stable across reorders/overwrites even when two
// tabs hold the same document.
let tabSeq = 0;
const freshTab = (): Tab => ({ uid: `tab${++tabSeq}`, ref: null, back: [], fwd: [] });

type PlaceholderView = "calendar" | "tasks" | "habits";

const PLACEHOLDER: Record<PlaceholderView, string> = {
  calendar: "A calendar is coming. Time keeps happening in the meantime.",
  tasks: "Tasks are on the way. Until then, a note that says “do the thing” works.",
  habits: "Habits, streaks, and gentle nudges are on the way.",
};

export interface AppShellProps {
  topInset?: number;
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
        today: "today",
        chat: "chat",
        calendar: "calendar",
        // notes/tasks are the workspace browse lists; the active tab's open document is
        // carried in the URL (/notes/:id, /tasks/:id) so it's bookmarkable. Other open tabs
        // stay session-only.
        notes: "notes/:id?",
        tasks: "tasks/:id?",
        habits: "habits",
        graph: "graph",
        trash: "trash",
        settings: "settings",
        notifications: "notifications",
        // Deep-linkable project drill-down: /project/<id>[/<section>[/<itemId>]].
        project: "project/:projectId/:section?/:itemId?",
      },
    },
  };
}

// The workspace (notes/tasks list + tab strip) is mounted persistently by Shell so per-tab
// editor state survives route changes; it doesn't live on the router. These screens only
// anchor the "notes"/"tasks" routes for linking + rail highlighting.
function NotesRouteScreen() {
  return null;
}
function TasksRouteScreen() {
  return null;
}

// Adapts the navigator-free NotificationsScreen to this shell: opening an entry's task
// selects it in the workspace tab strip.
function NotificationsRouteScreen() {
  const nav = useNav();
  return <NotificationsScreen onOpenTask={nav.openTask} />;
}

function ViewScreen() {
  const route = useRoute();
  return <ComingSoon view={route.name as PlaceholderView} />;
}

function CompanionNavigator({
  initialRouteName,
  children,
  screenOptions,
  topInset,
}: {
  initialRouteName?: string;
  children: ReactNode;
  screenOptions?: unknown;
  topInset: number;
}) {
  const { state, descriptors, navigation, NavigationContent } = useNavigationBuilder(StackRouter, {
    initialRouteName,
    children,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    screenOptions: screenOptions as any,
  });
  const route = state.routes[state.index];
  return (
    <NavigationContent>
      <NavBridge state={state} navigation={navigation} topInset={topInset}>
        {descriptors[route.key].render()}
      </NavBridge>
    </NavigationContent>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createCompanionNavigator = createNavigatorFactory(CompanionNavigator as any);
const Nav = createCompanionNavigator();

interface RouteParams {
  id?: string;
  projectId?: string;
  section?: string;
  itemId?: string;
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

/** Builds the useNav() API from the router state plus tab/forward state, and renders
 * the shell around the current screen. */
function NavBridge({
  state,
  navigation,
  topInset,
  children,
}: {
  state: StateLike;
  navigation: NavLike;
  topInset: number;
  children: ReactNode;
}) {
  const route = state.routes[state.index];
  const routeName = route.name;
  const inWorkspace = routeName === "notes" || routeName === "tasks";

  // The workspace tab strip: notes and tasks share one set of slots (always ≥ 1). Tabs are
  // session state; only the *active* tab's document is mirrored to the URL. Seed the first
  // tab from a bookmarked /notes/:id or /tasks/:id so the link opens that document.
  const [tabs, setTabs] = useState<Tab[]>(() => {
    const first = freshTab();
    const id = route.params?.id;
    const kind = routeName === "notes" ? "note" : routeName === "tasks" ? "task" : null;
    if (id && kind) first.ref = { kind, id };
    return [first];
  });
  const [activeIndex, setActiveIndex] = useState(0);
  const [forwardStack, setForwardStack] = useState<{ name: string; params?: RouteParams }[]>([]);

  const current: NavLocation =
    routeName === "project"
      ? {
          kind: "project",
          projectId: route.params?.projectId ?? "",
          section: route.params?.section as ProjectSection | undefined,
          itemId: route.params?.itemId,
        }
      : routeName === "tasks"
        ? { kind: "tasks" }
        : routeName === "notes"
          ? { kind: "notes" }
          : { kind: "view", view: routeName as Exclude<ViewId, "notes" | "tasks"> };

  const active = Math.min(activeIndex, tabs.length - 1);
  const activeTab = tabs[active];
  const activeRef = activeTab.ref;

  // Mirror the active tab's document into the URL as /notes/:id or /tasks/:id (bookmarkable),
  // but only while its kind matches the browsed section. `replace` keeps this out of the
  // route history — per-tab selection history (below) owns document navigation.
  useEffect(() => {
    if (!inWorkspace) return;
    const matches =
      activeRef &&
      ((activeRef.kind === "note" && routeName === "notes") || (activeRef.kind === "task" && routeName === "tasks"));
    const wantId = matches ? activeRef!.id : undefined;
    if ((route.params?.id ?? undefined) !== wantId) {
      navigation.dispatch(StackActions.replace(routeName, wantId ? { id: wantId } : {}));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inWorkspace, routeName, activeRef?.kind, activeRef?.id]);

  const nav = useMemo<Navigator>(() => {
    const goto = (name: string, params?: RouteParams) => {
      setForwardStack([]);
      navigation.dispatch(StackActions.push(name, params));
    };
    // Put the workspace section for `name` on screen. Entering from another view (graph,
    // project) pushes — so route Back returns there; switching sections *within* the
    // workspace replaces, so document selections never grow route history (the per-tab
    // history handles those). The :id param is filled by the effect above.
    const ensureSection = (name: "notes" | "tasks") => {
      if (routeName === name) return;
      if (inWorkspace) navigation.dispatch(StackActions.replace(name));
      else goto(name);
    };
    // Point the active tab at a document, remembering the one it replaces for per-tab Back.
    const selectRef = (ref: TabRef) => {
      setTabs((ts) =>
        ts.map((tab, i) => {
          if (i !== active) return tab;
          if (tab.ref && tab.ref.kind === ref.kind && tab.ref.id === ref.id) {
            // Re-select of the same document: keep history, but refresh its origin (a project
            // detail-pane select vs a plain workspace select) so the tab returns to the right
            // place when clicked.
            return tab.ref.projectId === ref.projectId ? tab : { ...tab, ref };
          }
          return { ...tab, ref, back: tab.ref ? [...tab.back, tab.ref] : tab.back, fwd: [] };
        }),
      );
    };
    // Put a tab's document on screen: a project-origin doc returns to its project route, a
    // plain doc to the shared workspace section. Skips a redundant push when already there.
    const showRef = (ref: TabRef) => {
      if (ref.projectId) {
        const here =
          current.kind === "project" && current.projectId === ref.projectId && current.itemId === ref.id;
        if (!here) goto("project", { projectId: ref.projectId, section: ref.kind === "note" ? "notes" : "tasks", itemId: ref.id });
        return;
      }
      ensureSection(ref.kind === "note" ? "notes" : "tasks");
    };
    // Restore a document from the active tab's Back (dir -1) or Forward (dir +1) stack.
    const stepTab = (dir: -1 | 1): boolean => {
      const tab = tabs[active];
      const from = dir === -1 ? tab.back : tab.fwd;
      if (!from.length) return false;
      const target = from[from.length - 1];
      setTabs((ts) =>
        ts.map((t, i) => {
          if (i !== active) return t;
          if (dir === -1) {
            return { ...t, ref: target, back: t.back.slice(0, -1), fwd: t.ref ? [...t.fwd, t.ref] : t.fwd };
          }
          return { ...t, ref: target, fwd: t.fwd.slice(0, -1), back: t.ref ? [...t.back, t.ref] : t.back };
        }),
      );
      showRef(target);
      return true;
    };
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
      current,
      activeView: routeName === "project" ? "project" : (routeName as ViewId),
      // In the workspace, Back/Forward walk the active tab's selection history first, then
      // fall back to the route history (to leave the workspace to where you came from).
      canBack: inWorkspace ? activeTab.back.length > 0 || state.index > 0 : state.index > 0,
      canForward: inWorkspace ? activeTab.fwd.length > 0 || forwardStack.length > 0 : forwardStack.length > 0,
      back: () => {
        if (inWorkspace && stepTab(-1)) return;
        const top = state.routes[state.index];
        setForwardStack((f) => [...f, { name: top.name, params: top.params }]);
        navigation.goBack();
      },
      forward: () => {
        if (inWorkspace && stepTab(1)) return;
        setForwardStack((f) => {
          if (!f.length) return f;
          const r = f[f.length - 1];
          navigation.dispatch(StackActions.push(r.name, r.params));
          return f.slice(0, -1);
        });
      },
      goView: (view) => {
        if (routeName === view) return;
        goto(view);
      },

      tabs,
      activeIndex: active,
      activeTab,
      openNote: (id) => {
        selectRef({ kind: "note", id });
        ensureSection("notes");
      },
      openTask: (id) => {
        selectRef({ kind: "task", id });
        ensureSection("tasks");
      },
      openInNewTab: (ref) => {
        // Append a tab already holding the document and focus it. Done in one shot (not
        // addTab + openTask) so it doesn't depend on the active index updating first.
        setTabs((t) => [...t, { ...freshTab(), ref }]);
        setActiveIndex(tabs.length);
        ensureSection(ref.kind === "note" ? "notes" : "tasks");
      },
      addTab: () => {
        setActiveIndex(tabs.length);
        setTabs((t) => [...t, freshTab()]);
      },
      selectTab: (index) => {
        setActiveIndex(index);
        const ref = tabs[index]?.ref;
        if (ref) showRef(ref);
      },
      closeTab: (index) => removeTab(index),
      expandTab: (index) => {
        const ref = tabs[index]?.ref;
        if (ref) openFocusWindow(ref.kind, ref.id);
        removeTab(index);
      },

      // Each level of the project drill-down is a push, so Back pops overview ← section
      // ← item and the URL stays deep-linkable.
      openProject: (projectId) => goto("project", { projectId }),
      openProjectSection: (projectId, section) => goto("project", { projectId, section }),
      openProjectItem: (projectId, section, itemId) => {
        // Selecting a note/task in a project also points the shared tab strip's active tab at
        // it, so the tab tracks the project detail pane (and stays put when you leave to the
        // workspace). Other sections (calendars/habits) carry no document, so leave tabs alone.
        if (section === "notes") selectRef({ kind: "note", id: itemId, projectId });
        else if (section === "tasks") selectRef({ kind: "task", id: itemId, projectId });
        goto("project", { projectId, section, itemId });
      },
    };
  }, [current, tabs, active, activeTab, routeName, inWorkspace, state, forwardStack, navigation]);

  return (
    <NavContext.Provider value={nav}>
      <ReminderNavigationBridge />
      <MultiSelectProvider>
        <DndProvider>
          <Shell topInset={topInset}>{children}</Shell>
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
      nav.goView("tasks");
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

export function AppShell({ topInset = 0, notificationScheduler, toolsStorage }: AppShellProps) {
  return (
    <ToolVisibilityProvider storage={toolsStorage}>
    <NotesProvider>
      <TasksProvider>
       <RemindersProvider scheduler={notificationScheduler}>
        <NotificationsProvider>
        <ProjectsProvider>
         <ObjectTypesProvider>
          <CalendarProvider>
          <ShellRoutes topInset={topInset} />
          </CalendarProvider>
         </ObjectTypesProvider>
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
function ShellRoutes({ topInset }: { topInset: number }) {
  const linking = useMemo(webLinking, []);
  const { tools, hidden } = useToolVisibility();
  const initialRoute = tools.find((t) => !hidden.has(t.id))?.id ?? "settings";
  return (
    <NavigationContainer linking={linking} documentTitle={{ enabled: false }}>
      <Nav.Navigator initialRouteName={initialRoute} topInset={topInset}>
        <Nav.Screen name="today" component={TodayScreen} />
        <Nav.Screen name="chat" component={ChatsScreen} />
        <Nav.Screen name="calendar" component={CalendarScreen} />
        <Nav.Screen name="notes" component={NotesRouteScreen} />
        <Nav.Screen name="tasks" component={TasksRouteScreen} />
        <Nav.Screen name="habits" component={ViewScreen} />
        <Nav.Screen name="graph" component={GraphScreen} />
        <Nav.Screen name="trash" component={TrashScreen} />
        <Nav.Screen name="settings" component={SettingsScreen} />
        <Nav.Screen name="notifications" component={NotificationsRouteScreen} />
        <Nav.Screen name="project" component={ProjectView} />
      </Nav.Navigator>
    </NavigationContainer>
  );
}

/** The persistent chrome: hover-reveal rail + inset Frame(toolbar) around the current
 * screen (children). */
function Shell({ topInset, children }: { topInset: number; children: ReactNode }) {
  const nav = useNav();
  // The notes/tasks workspace is shown for both those sections (it's one shared thing).
  const inWorkspace = nav.current.kind === "notes" || nav.current.kind === "tasks";
  const sync = useSync();
  const dnd = useDnd();
  const { deleteArea } = useProjects();
  // The area pending deletion — its confirm dialog is rendered at the shell root, outside
  // the clipped (overflow:hidden) rail so the scrim can cover the whole window.
  const [deletingArea, setDeletingArea] = useState<SidebarArea | null>(null);
  // Per-device tool hiding (Settings › Tools): only the rail entry disappears — the view
  // itself stays routable.
  const { tools, hidden } = useToolVisibility();
  const rail = tools.filter((t) => !hidden.has(t.id));
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = usePersistentBoolean("companion.sidebar.pinned", false);
  // Reveal the rail while dragging a document, so projects are available as drop targets.
  const expanded = open || pinned || dnd.dragging != null;
  const activeProjectId = nav.current.kind === "project" ? nav.current.projectId : null;

  // Sync on navigation (§5.4). Key on the location + active tab so param-only changes fire.
  const loc = nav.current;
  const locKey =
    loc.kind +
    (nav.activeTab.ref ? `${nav.activeTab.ref.kind}:${nav.activeTab.ref.id}` : "") +
    (loc.kind === "project" ? `${loc.projectId}:${loc.section ?? ""}:${loc.itemId ?? ""}` : "");
  // Depend on the stable `trigger`, not the whole `sync` object: `sync` is a memo that
  // changes identity on every status/lastSyncedAt update, so listing it here would
  // re-fire this effect after each sync and loop (a sync every ~second).
  const syncTrigger = sync.trigger;
  useEffect(() => {
    syncTrigger();
  }, [locKey, syncTrigger]);

  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: colors.surfaceApp }}>
      <View
        onPointerEnter={() => setOpen(true)}
        onPointerLeave={() => setOpen(false)}
        style={[
          dragRegion,
          {
            width: expanded ? layout.railOpenW : layout.railW,
            flexShrink: 0,
            paddingHorizontal: space.md,
            paddingTop: space.md + topInset,
            paddingBottom: space.md,
            overflow: "hidden",
          },
          transition("width", 200),
        ]}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.lg, height: 40, paddingHorizontal: space.sm, marginBottom: space.md }}>
          <Mark />
          {expanded ? (
            <>
              <Text variant="title" style={{ flex: 1 }} numberOfLines={1}>
                companion
              </Text>
              <IconButton label={pinned ? "Unpin sidebar" : "Pin sidebar"} size="sm" active={pinned} onPress={() => setPinned((p) => !p)}>
                <Icon name="panelLeft" size={16} color={pinned ? colors.accentHover : colors.textSecondary} />
              </IconButton>
            </>
          ) : null}
        </View>

        <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ flexGrow: 1 }}>
          <View style={{ gap: 3 }}>
            {rail.map((n) => (
              <RailItem
                key={n.id}
                icon={<Icon name={n.icon} size={19} color={nav.activeView === n.id ? colors.accentHover : colors.textSecondary} />}
                label={n.label}
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
          <View style={{ flexGrow: 1, minHeight: space.xl }} />
        </ScrollView>

        <View style={{ gap: space.sm, paddingTop: space.md }}>
          <RailItem
            icon={<Icon name="settings" size={18} color={nav.activeView === "settings" ? colors.accentHover : colors.textSecondary} />}
            label="Settings"
            active={nav.activeView === "settings"}
            expanded={expanded}
            onPress={() => nav.goView("settings")}
          />
        </View>
      </View>

      <View style={{ flex: 1, minWidth: 0 }}>
        {/* Sync health: prompts re-auth / unlock in Settings when sync is blocked (§7). */}
        <SyncHealthBanner onOpenSettings={() => nav.goView("settings")} />
        <Frame toolbar={<AppToolbar />}>
          {/* The workspace (notes/tasks list + shared tab strip) is mounted once and only
              shown on those sections; keeping it alive across route changes is what makes
              every open tab's editor stateful. Other views render through the router. */}
          <View style={[{ flex: 1 }, inWorkspace ? null : { display: "none" }]}>
            <WorkspaceScreen />
          </View>
          {inWorkspace ? null : children}
        </Frame>
      </View>

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

function ComingSoon({ view }: { view: PlaceholderView }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space.xxxl }}>
      <Text tone="tertiary" style={{ textAlign: "center", maxWidth: 360, lineHeight: 22 }}>
        {PLACEHOLDER[view]}
      </Text>
    </View>
  );
}

function Mark({ size = 26 }: { size?: number }) {
  return (
    <View style={{ flexShrink: 0 }}>
      <BrandMark size={size} />
    </View>
  );
}

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
