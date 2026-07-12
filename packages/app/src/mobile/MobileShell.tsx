import { useEffect, useMemo, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import {
  NavigationContainer,
  StackActions,
  StackRouter,
  createNavigatorFactory,
  useNavigationBuilder,
  type LinkingOptions,
  type ParamListBase,
} from "@react-navigation/native";
import { Icon, IconButton, Text, colors, space } from "@companion/design-system";
import { NavContext, useNav, type NavLocation, type Navigator, type ProjectSection, type Tab, type ViewId } from "../nav-context";
import { useCore } from "../CoreContext";
import { setReminderActivationHandler } from "../reminderNav";
import { NotesProvider } from "../NotesProvider";
import { TasksProvider } from "../TasksProvider";
import { RemindersProvider, type NotificationScheduler } from "../RemindersProvider";
import { NotificationsProvider } from "../NotificationsProvider";
import { NotificationsScreen } from "../NotificationsScreen";
import { ToolVisibilityProvider, type ToolsStorage } from "../ToolVisibilityProvider";
import { ProjectsProvider, useProjects } from "../ProjectsProvider";
import { ObjectTypesProvider } from "../ObjectTypesProvider";
import { CalendarProvider } from "../CalendarProvider";
import { GraphScreen } from "../GraphScreen";
import { TrashScreen } from "../TrashScreen";
import { useSync } from "../SyncProvider";
import { SyncHealthBanner } from "../SyncHealthBanner";
import { SETTINGS_SECTIONS } from "../settingsSections";
import { HomeScreen } from "./HomeScreen";
import { TodayScreen } from "./TodayScreen";
import { CalendarScreen } from "./CalendarScreens";
import { ChatListScreen, ChatConversationScreen } from "./ChatScreens";
import { NotesListScreen, TasksListScreen } from "./ListScreens";
import { NoteEditorScreen, TaskEditorScreen } from "./EditorScreens";
import { ProjectScreen } from "./ProjectScreen";
import { SettingsListScreen, SettingsSectionScreen } from "./SettingsScreens";

// ---------------------------------------------------------------------------
// The mobile web shell (phone-width browsers / PWA). Same information architecture as
// the native mobile app (apps/mobile): a Home list of sections + the areas → projects
// tree, with every destination a pushed full-screen route. Reuses the shared data
// providers and screens; only the navigation chrome is mobile-specific. The desktop
// AppShell (hover rail + workspace tabs) is intentionally not reused here — see
// apps/mobile/src/MobileShell.tsx for the same decision on native.
//
// Navigation is React Navigation's StackRouter under a custom navigator (the same
// technique as AppShell), so URLs stay deep-linkable and compatible with the desktop
// shell's: /notes/:id opens the workspace there and the full-screen editor here.
// ---------------------------------------------------------------------------

export interface MobileWebShellProps {
  /** Extra top padding from a host window's chrome (unused in plain browsers). */
  topInset?: number;
  /** Per-platform reminder scheduler (PLAN §6.4); defaults to the web `Notification` one. */
  notificationScheduler?: NotificationScheduler;
  /** Where per-device tool visibility persists; defaults to localStorage. */
  toolsStorage?: ToolsStorage;
}

/** URL linking, web only (http/https) — one path space shared with the desktop shell. */
function mobileLinking(): LinkingOptions<ParamListBase> | undefined {
  if (typeof window === "undefined" || !/^https?:$/.test(window.location.protocol)) return undefined;
  return {
    prefixes: [window.location.origin],
    config: {
      screens: {
        home: "",
        today: "today",
        chat: "chat",
        chatConversation: "chat/:chatId",
        calendar: "calendar",
        notes: "notes",
        note: "notes/:id",
        tasks: "tasks",
        task: "tasks/:id",
        habits: "habits",
        graph: "graph",
        trash: "trash",
        settings: "settings",
        settingsSection: "settings/:section",
        notifications: "notifications",
        project: "project/:projectId/:section?/:itemId?",
      },
    },
  };
}

interface RouteParams {
  id?: string;
  chatId?: string;
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

function MobileNavigator({
  initialRouteName,
  children,
  topInset,
}: {
  initialRouteName?: string;
  children: ReactNode;
  topInset: number;
}) {
  const { state, descriptors, navigation, NavigationContent } = useNavigationBuilder(StackRouter, {
    initialRouteName,
    children,
  });
  const route = state.routes[state.index];
  return (
    <NavigationContent>
      <MobileNavBridge state={state} navigation={navigation} topInset={topInset}>
        {descriptors[route.key].render()}
      </MobileNavBridge>
    </NavigationContent>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createMobileNavigator = createNavigatorFactory(MobileNavigator as any);
const Nav = createMobileNavigator();

// The mobile shell has no workspace tab strip; the shared Navigator interface still
// carries one, so a single permanently-empty slot stands in.
const EMPTY_TAB: Tab = { uid: "m0", ref: null, back: [], fwd: [] };

const TITLES: Record<string, string> = {
  today: "Today",
  chat: "Chat",
  chatConversation: "Chat",
  calendar: "Calendar",
  notes: "Notes",
  note: "Note",
  tasks: "Tasks",
  task: "Task",
  habits: "Habits",
  graph: "Graph",
  trash: "Trash",
  settings: "Settings",
  notifications: "Notifications",
};

// Where the header back button lands when a deep link is the first (only) route.
const BACK_FALLBACK: Record<string, string> = {
  note: "notes",
  task: "tasks",
  chatConversation: "chat",
  settingsSection: "settings",
};

// Route → rail-equivalent view id, for the shared Navigator's activeView field.
const ACTIVE_VIEW: Record<string, ViewId | "project"> = {
  note: "notes",
  task: "tasks",
  chatConversation: "chat",
  settingsSection: "settings",
  project: "project",
  home: "today",
};

/** Builds the useNav() API on the router state and renders the shell chrome (sync
 * banner + back header) around the current screen. */
function MobileNavBridge({
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
  const params = route.params ?? {};

  const nav = useMemo<Navigator>(() => {
    const push = (name: string, p?: RouteParams) => navigation.dispatch(StackActions.push(name, p));
    const openNote = (id: string) => {
      if (routeName === "note" && params.id === id) return;
      push("note", { id });
    };
    const openTask = (id: string) => {
      if (routeName === "task" && params.id === id) return;
      push("task", { id });
    };

    const current: NavLocation =
      routeName === "project"
        ? {
            kind: "project",
            projectId: params.projectId ?? "",
            section: params.section as ProjectSection | undefined,
            itemId: params.itemId,
          }
        : routeName === "notes" || routeName === "note"
          ? { kind: "notes" }
          : routeName === "tasks" || routeName === "task"
            ? { kind: "tasks" }
            : { kind: "view", view: (ACTIVE_VIEW[routeName] ?? routeName) as Exclude<ViewId, "notes" | "tasks"> };

    return {
      current,
      activeView: ACTIVE_VIEW[routeName] ?? (routeName as ViewId),
      canBack: state.index > 0,
      canForward: false,
      back: () => {
        if (state.index > 0) navigation.goBack();
        // A deep link landed here directly: step "up" instead of back.
        else navigation.dispatch(StackActions.replace(BACK_FALLBACK[routeName] ?? "home"));
      },
      forward: () => {},
      // navigate (not push) so revisiting a section pops back to it instead of growing
      // the stack forever (home → notes → home → …).
      goView: (view) => {
        if (routeName !== view) navigation.navigate(view);
      },

      tabs: [EMPTY_TAB],
      activeIndex: 0,
      activeTab: EMPTY_TAB,
      openNote,
      openTask,
      // No tab strip here: "open in new tab" (link chips) pushes the editor route.
      openInNewTab: (ref) => (ref.kind === "note" ? openNote(ref.id) : openTask(ref.id)),
      addTab: () => {},
      selectTab: () => {},
      closeTab: () => {},
      expandTab: () => {},

      openProject: (projectId) => push("project", { projectId }),
      openProjectSection: (projectId, section) => push("project", { projectId, section }),
      // A project item opens as a plain full-screen editor (the editor's own project
      // chrome is the way back into the project on this shell).
      openProjectItem: (projectId, section, itemId) => {
        if (section === "notes") openNote(itemId);
        else if (section === "tasks") openTask(itemId);
        else push("project", { projectId, section });
      },
    };
  }, [routeName, params.id, params.projectId, params.section, params.itemId, state.index, navigation]);

  // Sync on navigation (§5.4), same contract as the desktop Shell. Depend on the stable
  // `trigger`, not the whole `sync` memo (see AppShell for the loop this avoids).
  const locKey = routeName + (params.id ?? "") + (params.projectId ?? "") + (params.chatId ?? "") + (params.section ?? "");
  const syncTrigger = useSync().trigger;
  useEffect(() => {
    syncTrigger();
  }, [locKey, syncTrigger]);

  return (
    <NavContext.Provider value={nav}>
      <MobileReminderBridge />
      <View style={[styles.root, { paddingTop: topInset }]}>
        <SyncHealthBanner onOpenSettings={() => nav.goView("settings")} />
        {routeName === "home" ? null : <Header routeName={routeName} params={params} onBack={nav.back} />}
        <View style={styles.content}>{children}</View>
      </View>
    </NavContext.Provider>
  );
}

/** The back header on every pushed screen. Titles are static per route; a project
 * resolves its name (and a settings section its label) from the registries. */
function Header({ routeName, params, onBack }: { routeName: string; params: RouteParams; onBack: () => void }) {
  const { projects } = useProjects();
  const title =
    routeName === "project"
      ? (projects.find((p) => p.id === params.projectId)?.name ?? "Project")
      : routeName === "settingsSection"
        ? (SETTINGS_SECTIONS.find((s) => s.id === params.section)?.label ?? "Settings")
        : (TITLES[routeName] ?? "");
  return (
    <View style={styles.header}>
      <IconButton label="Back" onPress={onBack}>
        <Icon name="chevronLeft" size={22} color={colors.textSecondary} />
      </IconButton>
      <Text variant="title" numberOfLines={1} style={styles.headerTitle}>
        {title}
      </Text>
      {/* Balance the back button so the title centers optically. */}
      <View style={styles.headerSpacer} />
    </View>
  );
}

/** Bridges a tapped reminder to navigation (PLAN §6.4): the web `Notification` onclick
 * (via the shared activateReminder registry) and any `notify.activate` core event both
 * open the task's editor. */
function MobileReminderBridge() {
  const nav = useNav();
  const { core } = useCore();
  useEffect(() => {
    const open = (taskId: string) => {
      if (taskId) nav.openTask(taskId);
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

// Anchors the notifications route to the shell: opening an entry's task pushes its editor.
function NotificationsRouteScreen() {
  const nav = useNav();
  return <NotificationsScreen onOpenTask={nav.openTask} />;
}

function HabitsScreen() {
  return (
    <View style={styles.placeholder}>
      <Text tone="tertiary" style={styles.placeholderText}>
        Habits, streaks, and gentle nudges are on the way.
      </Text>
    </View>
  );
}

export function MobileWebShell({ topInset = 0, notificationScheduler, toolsStorage }: MobileWebShellProps) {
  const linking = useMemo(mobileLinking, []);
  return (
    <ToolVisibilityProvider storage={toolsStorage}>
      <NotesProvider>
        <TasksProvider>
          <RemindersProvider scheduler={notificationScheduler}>
            <NotificationsProvider>
              <ProjectsProvider>
                <ObjectTypesProvider>
                  <CalendarProvider>
                    <NavigationContainer linking={linking} documentTitle={{ enabled: false }}>
                      <Nav.Navigator initialRouteName="home" topInset={topInset}>
                        <Nav.Screen name="home" component={HomeScreen} />
                        <Nav.Screen name="today" component={TodayScreen} />
                        <Nav.Screen name="chat" component={ChatListScreen} />
                        <Nav.Screen name="chatConversation" component={ChatConversationScreen} />
                        <Nav.Screen name="calendar" component={CalendarScreen} />
                        <Nav.Screen name="notes" component={NotesListScreen} />
                        <Nav.Screen name="note" component={NoteEditorScreen} />
                        <Nav.Screen name="tasks" component={TasksListScreen} />
                        <Nav.Screen name="task" component={TaskEditorScreen} />
                        <Nav.Screen name="habits" component={HabitsScreen} />
                        <Nav.Screen name="graph" component={GraphScreen} />
                        <Nav.Screen name="trash" component={TrashScreen} />
                        <Nav.Screen name="settings" component={SettingsListScreen} />
                        <Nav.Screen name="settingsSection" component={SettingsSectionScreen} />
                        <Nav.Screen name="notifications" component={NotificationsRouteScreen} />
                        <Nav.Screen name="project" component={ProjectScreen} />
                      </Nav.Navigator>
                    </NavigationContainer>
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

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceApp },
  content: { flex: 1, minHeight: 0 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    height: 48,
    paddingHorizontal: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.surfaceApp,
  },
  headerTitle: { flex: 1, textAlign: "center" },
  headerSpacer: { width: 34 },
  placeholder: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xxxl },
  placeholderText: { textAlign: "center", maxWidth: 360, lineHeight: 22 },
});
