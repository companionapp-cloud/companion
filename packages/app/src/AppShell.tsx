import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
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
import { NavContext, useNav, type NavLocation, type Navigator, type ProjectSection, type ViewId } from "./nav-context";
import { NotesProvider } from "./NotesProvider";
import { ProjectsProvider } from "./ProjectsProvider";
import { ProjectsSidebar } from "./ProjectsSidebar";
import { ProjectView } from "./ProjectView";
import { AppToolbar } from "./AppToolbar";
import { NotesScreen } from "./NotesScreen";
import { GraphScreen } from "./GraphScreen";
import { TrashScreen } from "./TrashScreen";
import { SettingsPanel } from "./SettingsPanel";
import { useSync } from "./SyncProvider";

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
        tasks: "tasks",
        habits: "habits",
        graph: "graph",
        trash: "trash",
        notes: "notes/:id?",
        // Deep-linkable project drill-down: /project/<id>[/<section>[/<itemId>]].
        project: "project/:projectId/:section?/:itemId?",
      },
    },
  };
}

// The notes UI is mounted persistently by Shell (so per-tab editor state survives route
// changes), not on the router. This screen only anchors the "notes" route for linking.
function NotesRouteScreen() {
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
  const [tabs, setTabs] = useState<string[]>([]);
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
      : routeName === "notes"
        ? route.params?.id
          ? { kind: "note", id: route.params.id }
          : { kind: "notes" }
        : { kind: "view", view: routeName as Exclude<ViewId, "notes"> };

  const nav = useMemo<Navigator>(() => {
    const goto = (name: string, params?: RouteParams) => {
      setForwardStack([]);
      navigation.dispatch(StackActions.push(name, params));
    };
    return {
      current,
      tabs,
      activeView: routeName === "project" ? "project" : routeName === "notes" ? "notes" : (routeName as ViewId),
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
        if (routeName === view && !(view === "notes" && current.kind === "note")) return;
        goto(view);
      },
      openNote: (id, opts) => {
        setTabs((t) => {
          if (t.includes(id)) return t;
          // Cmd/Ctrl-click always adds a new tab; otherwise, if a note tab is currently
          // active, replace it in place with the new note.
          if (!opts?.newTab && current.kind === "note") {
            const i = t.indexOf(current.id);
            if (i !== -1) {
              const next = [...t];
              next[i] = id;
              return next;
            }
          }
          return [...t, id];
        });
        goto("notes", { id });
      },
      closeTab: (id) => {
        setTabs((t) => t.filter((x) => x !== id));
        if (current.kind === "note" && current.id === id) {
          const remaining = tabs.filter((x) => x !== id);
          goto("notes", remaining.length ? { id: remaining[remaining.length - 1] } : undefined);
        }
      },
      deselect: () => {
        if (current.kind === "note") goto("notes");
      },
      // Each level of the project drill-down is a push, so Back pops overview ← section
      // ← item and the URL stays deep-linkable.
      openProject: (projectId) => goto("project", { projectId }),
      openProjectSection: (projectId, section) => goto("project", { projectId, section }),
      openProjectItem: (projectId, section, itemId) => goto("project", { projectId, section, itemId }),
    };
  }, [current, tabs, routeName, state, forwardStack, navigation]);

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
      <ProjectsProvider>
        <NavigationContainer linking={linking} documentTitle={{ enabled: false }}>
          <Nav.Navigator initialRouteName="notes" topInset={topInset}>
            <Nav.Screen name="chat" component={ViewScreen} />
            <Nav.Screen name="calendar" component={ViewScreen} />
            <Nav.Screen name="notes" component={NotesRouteScreen} />
            <Nav.Screen name="tasks" component={ViewScreen} />
            <Nav.Screen name="habits" component={ViewScreen} />
            <Nav.Screen name="graph" component={GraphScreen} />
            <Nav.Screen name="trash" component={TrashScreen} />
            <Nav.Screen name="project" component={ProjectView} />
          </Nav.Navigator>
        </NavigationContainer>
      </ProjectsProvider>
    </NotesProvider>
  );
}

/** The persistent chrome: hover-reveal rail + inset Frame(toolbar) around the current
 * screen (children). */
function Shell({ topInset, children }: { topInset: number; children: ReactNode }) {
  const nav = useNav();
  const onNotes = nav.activeView === "notes";
  const sync = useSync();
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pinned, setPinned] = usePersistentBoolean("companion.sidebar.pinned", false);
  const expanded = open || pinned;
  const activeProjectId = nav.current.kind === "project" ? nav.current.projectId : null;

  // Sync on navigation (§5.4). Key on the location so param-only changes still fire.
  const loc = nav.current;
  const locKey =
    loc.kind +
    (loc.kind === "note" ? loc.id : "") +
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
          {/* Empty rail space deselects the active note (still a window drag handle on desktop). */}
          <Pressable onPress={nav.deselect} style={{ flexGrow: 1, minHeight: space.xl, cursor: "auto" }} aria-label="Deselect note" />
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
          {/* Notes is mounted once and only shown on the notes view; keeping it alive
              across route changes is what makes tabs stateful (see NotesScreen). Other
              views render through the router as usual. */}
          <View style={[{ flex: 1 }, onNotes ? null : { display: "none" }]}>
            <NotesScreen />
          </View>
          {onNotes ? null : children}
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
