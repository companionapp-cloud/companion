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
  Frame,
  Icon,
  IconButton,
  RailItem,
  Text,
  colors,
  dragRegion,
  layout,
  radius,
  space,
  transition,
  type IconName,
} from "@companion/design-system";
import { NavContext, useNav, type NavLocation, type Navigator, type ProjectSection, type Tab, type TabRef, type ViewId } from "./nav-context";
import { openFocusWindow } from "./focus";
import { NotesProvider } from "./NotesProvider";
import { TasksProvider } from "./TasksProvider";
import { RemindersProvider } from "./RemindersProvider";
import { ProjectsProvider } from "./ProjectsProvider";
import { ProjectsSidebar } from "./ProjectsSidebar";
import { ProjectView } from "./ProjectView";
import { AppToolbar } from "./AppToolbar";
import { WorkspaceScreen } from "./WorkspaceScreen";
import { GraphScreen } from "./GraphScreen";
import { TrashScreen } from "./TrashScreen";
import { SettingsPanel } from "./SettingsPanel";
import { useSync } from "./SyncProvider";

// Monotonic tab uid so React keys are stable across reorders/overwrites even when two
// tabs hold the same document.
let tabSeq = 0;
const freshTab = (): Tab => ({ uid: `tab${++tabSeq}`, ref: null });

const NAV: { id: ViewId; label: string; icon: IconName }[] = [
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "calendar", label: "Calendar", icon: "calendar" },
  { id: "notes", label: "Notes", icon: "notes" },
  { id: "tasks", label: "Tasks", icon: "tasks" },
  { id: "habits", label: "Habits", icon: "habits" },
  { id: "graph", label: "Graph", icon: "graph" },
  { id: "trash", label: "Trash", icon: "trash" },
];

type PlaceholderView = "chat" | "calendar" | "tasks" | "habits";

const PLACEHOLDER: Record<PlaceholderView, string> = {
  chat: "Chat lands here soon. For now, your notes are just to the left.",
  calendar: "A calendar is coming. Time keeps happening in the meantime.",
  tasks: "Tasks are on the way. Until then, a note that says “do the thing” works.",
  habits: "Habits, streaks, and gentle nudges are on the way.",
};

export interface AppShellProps {
  topInset?: number;
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
        chat: "chat",
        calendar: "calendar",
        // notes/tasks are the two workspace browse lists; open documents live in session
        // tabs (not the URL). A specific document is deep-linked via focus mode (?note= /
        // ?task=), which the expand/pop-out action opens.
        notes: "notes",
        tasks: "tasks",
        habits: "habits",
        graph: "graph",
        trash: "trash",
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
  // The workspace tab strip: notes and tasks share one set of slots (always ≥ 1). Tabs are
  // session state, not in the URL; the route only tracks which list is browsed.
  const [tabs, setTabs] = useState<Tab[]>(() => [freshTab()]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [forwardStack, setForwardStack] = useState<{ name: string; params?: RouteParams }[]>([]);

  const route = state.routes[state.index];
  const routeName = route.name;
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

  const nav = useMemo<Navigator>(() => {
    const goto = (name: string, params?: RouteParams) => {
      setForwardStack([]);
      navigation.dispatch(StackActions.push(name, params));
    };
    // Ensure the workspace for `kind` is on screen (so a doc opened from elsewhere — the
    // graph, a project — becomes visible), without stacking history when already there.
    const ensureRoute = (name: string) => {
      if (routeName !== name) goto(name);
    };
    // Overwrite the active tab's document. Opening a note/task shows its matching list.
    const setActiveRef = (ref: TabRef) => {
      setTabs((t) => t.map((tab, i) => (i === active ? { ...tab, ref } : tab)));
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
      canBack: state.index > 0,
      canForward: forwardStack.length > 0,
      back: () => {
        const top = state.routes[state.index];
        setForwardStack((f) => [...f, { name: top.name, params: top.params }]);
        navigation.goBack();
      },
      forward: () => {
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
        setActiveRef({ kind: "note", id });
        ensureRoute("notes");
      },
      openTask: (id) => {
        setActiveRef({ kind: "task", id });
        ensureRoute("tasks");
      },
      addTab: () => {
        setActiveIndex(tabs.length);
        setTabs((t) => [...t, freshTab()]);
      },
      selectTab: (index) => setActiveIndex(index),
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
      openProjectItem: (projectId, section, itemId) => goto("project", { projectId, section, itemId }),
    };
  }, [current, tabs, active, activeTab, routeName, state, forwardStack, navigation]);

  return (
    <NavContext.Provider value={nav}>
      <Shell topInset={topInset}>{children}</Shell>
    </NavContext.Provider>
  );
}

export function AppShell({ topInset = 0 }: AppShellProps) {
  const linking = useMemo(webLinking, []);
  return (
    <NotesProvider>
      <TasksProvider>
       <RemindersProvider>
        <ProjectsProvider>
          <NavigationContainer linking={linking} documentTitle={{ enabled: false }}>
            <Nav.Navigator initialRouteName="notes" topInset={topInset}>
              <Nav.Screen name="chat" component={ViewScreen} />
              <Nav.Screen name="calendar" component={ViewScreen} />
              <Nav.Screen name="notes" component={NotesRouteScreen} />
              <Nav.Screen name="tasks" component={TasksRouteScreen} />
              <Nav.Screen name="habits" component={ViewScreen} />
              <Nav.Screen name="graph" component={GraphScreen} />
              <Nav.Screen name="trash" component={TrashScreen} />
              <Nav.Screen name="project" component={ProjectView} />
            </Nav.Navigator>
          </NavigationContainer>
        </ProjectsProvider>
       </RemindersProvider>
      </TasksProvider>
    </NotesProvider>
  );
}

/** The persistent chrome: hover-reveal rail + inset Frame(toolbar) around the current
 * screen (children). */
function Shell({ topInset, children }: { topInset: number; children: ReactNode }) {
  const nav = useNav();
  // The notes/tasks workspace is shown for both those sections (it's one shared thing).
  const inWorkspace = nav.current.kind === "notes" || nav.current.kind === "tasks";
  const sync = useSync();
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pinned, setPinned] = usePersistentBoolean("companion.sidebar.pinned", false);
  const expanded = open || pinned;
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
            {NAV.map((n) => (
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
          {expanded ? <ProjectsSidebar onSelectProject={nav.openProject} activeProjectId={activeProjectId} /> : null}
          {/* Empty rail space fills the column (a window drag handle on desktop). */}
          <View style={{ flexGrow: 1, minHeight: space.xl }} />
        </ScrollView>

        <View style={{ gap: space.sm, paddingTop: space.md }}>
          <RailItem
            icon={<Icon name="settings" size={18} color={settingsOpen ? colors.accentHover : colors.textSecondary} />}
            label="Settings"
            active={settingsOpen}
            expanded={expanded}
            onPress={() => setSettingsOpen(true)}
          />
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.lg, paddingHorizontal: space.sm, height: 32 }}>
            <Avatar name="You" size="sm" />
            {expanded ? (
              <Text variant="caption" tone="secondary" numberOfLines={1} style={{ flex: 1 }}>
                you@companion.so
              </Text>
            ) : null}
          </View>
        </View>
      </View>

      <View style={{ flex: 1, minWidth: 0 }}>
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

      {settingsOpen ? <SettingsPanel onClose={() => setSettingsOpen(false)} /> : null}
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
  const dot = Math.round(size * 0.3);
  return (
    <View style={{ width: size, height: size, borderRadius: radius.lg, backgroundColor: colors.accent, flexShrink: 0 }}>
      <View style={{ position: "absolute", width: dot, height: dot, borderRadius: radius.full, backgroundColor: colors.gray0, top: Math.round(size * 0.2), left: Math.round(size * 0.2) }} />
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
