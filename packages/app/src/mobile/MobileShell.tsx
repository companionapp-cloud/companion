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
import { DensityProvider, colors } from "@companion/design-system";
import { NavContext, useNav, type AreaSection, type NavLocation, type Navigator, type ProjectSection, type Tab, type TabRef, type ViewId } from "../nav-context";
import { useCore } from "../CoreContext";
import { setReminderActivationHandler } from "../reminderNav";
import { NotesProvider } from "../NotesProvider";
import { TasksProvider } from "../TasksProvider";
import { ListsProvider } from "../ListsProvider";
import { CanvasesProvider } from "../canvas/CanvasesProvider";
import { CanvasesListScreen, CanvasScreen } from "./CanvasScreens";
import { RemindersProvider, type NotificationScheduler } from "../RemindersProvider";
import { NotificationsProvider } from "../NotificationsProvider";
import { ToolVisibilityProvider, type ToolsStorage } from "../ToolVisibilityProvider";
import { ProjectsProvider } from "../ProjectsProvider";
import { ObjectTypesProvider } from "../ObjectTypesProvider";
import { CalendarProvider } from "../CalendarProvider";
import { useSync } from "../SyncProvider";
import { SyncHealthBanner } from "../SyncHealthBanner";
import { HomeScreen } from "./HomeScreen";
import { TodayScreen } from "./TodayScreen";
import { CalendarScreen } from "./CalendarScreens";
import { ChatListScreen, ChatConversationScreen } from "./ChatScreens";
import { NotesListScreen, TasksListScreen } from "./ListScreens";
import { NoteEditorScreen, TaskEditorScreen } from "./EditorScreens";
import { AreaScreen, ProjectScreen } from "./ProjectScreen";
import { SettingsListScreen, SettingsSectionScreen } from "./SettingsScreens";
import { GraphScreen } from "./GraphScreen";
import { HabitsScreen, LogbookRouteScreen, NotificationsRouteScreen, TrashRouteScreen } from "./UtilityScreens";
import { ThingsImportHost } from "../ThingsImport";
import { PushPromptBanner } from "../push/PushPromptBanner";
import { InstallGuideRouteScreen } from "../push/InstallGuide";

// ---------------------------------------------------------------------------
// The mobile web shell (phone-width browsers / PWA). Same information architecture as
// the native mobile app (apps/mobile): a Home list of sections + the areas → projects
// tree, with every destination a pushed full-screen route. Reuses the shared data
// providers and screens; only the navigation chrome is mobile-specific. The desktop
// AppShell (hover rail + workspace tabs) is intentionally not reused here — see
// apps/mobile/src/MobileShell.tsx for the same decision on native.
//
// Chrome follows platform habit: Home owns a large title and has no bar; every other
// route renders its own 44px NavBar (./ui) so it can put its actions and its segmented
// control in the bar. The shell mounts touch density once, at the root, so the shared
// primitives and screens beneath pick 44px rows and `lg` controls.
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
        today: "today/:date?",
        chat: "chat",
        chatConversation: "chat/:chatId",
        calendar: "calendar",
        notes: "notes",
        note: "notes/:id",
        tasks: "tasks",
        task: "tasks/:id",
        canvases: "canvases",
        canvas: "canvases/:id",
        habits: "habits",
        graph: "graph",
        logbook: "logbook",
        trash: "trash",
        settings: "settings",
        settingsSection: "settings/:section",
        notifications: "notifications",
        install: "install",
        project: "project/:projectId/:section?/:itemId?/:subItemId?",
        area: "area/:areaId/:section?",
      },
    },
  };
}

interface RouteParams {
  id?: string;
  date?: string;
  chatId?: string;
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

// Where the header back button lands when a deep link is the first (only) route.
const BACK_FALLBACK: Record<string, string> = {
  note: "notes",
  task: "tasks",
  canvas: "canvases",
  chatConversation: "chat",
  settingsSection: "settings",
};

/** An area holds only notes, tasks and canvases; anything else in the URL is its overview. */
function asAreaSection(section: string | undefined): AreaSection | undefined {
  return section === "notes" || section === "tasks" || section === "canvases" ? section : undefined;
}

// Route → rail-equivalent view id, for the shared Navigator's activeView field.
const ACTIVE_VIEW: Record<string, ViewId | "project" | "area"> = {
  note: "notes",
  task: "tasks",
  canvas: "canvases",
  chatConversation: "chat",
  settingsSection: "settings",
  project: "project",
  area: "area",
  home: "today",
};

/** Builds the useNav() API on the router state and renders the shell chrome (the sync
 * banner) around the current screen; each screen brings its own nav bar. */
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
    const openCanvas = (id: string) => {
      if (routeName === "canvas" && params.id === id) return;
      push("canvas", { id });
    };
    // A project item opens as a plain full-screen editor (the editor's own project
    // chrome is the way back into the project on this shell).
    const openProjectItem = (projectId: string, section: ProjectSection, itemId: string) => {
      if (section === "notes") openNote(itemId);
      else if (section === "tasks") openTask(itemId);
      else if (section === "canvases") push("canvas", { id: itemId });
      else push("project", { projectId, section, itemId });
    };
    // Every surface is a pushed route here, so a tab's contents map onto the route that
    // shows them. Today opened on a day (a dated note from the calendar or the graph)
    // navigates there with the date.
    const openRef = (ref: TabRef) => {
      switch (ref.kind) {
        case "view":
          if (ref.view === "today") navigation.navigate("today", ref.date ? { date: ref.date } : undefined);
          else if (ref.view === "settings" && ref.section) navigation.navigate("settingsSection", { section: ref.section });
          else if (routeName !== ref.view) navigation.navigate(ref.view);
          return;
        case "browse":
          if (routeName !== ref.section) navigation.navigate(ref.section);
          return;
        case "project":
          // A task inside a list opens as the full-screen task editor on this shell.
          if (ref.subItemId) openTask(ref.subItemId);
          else if (ref.section && ref.itemId) openProjectItem(ref.projectId, ref.section, ref.itemId);
          else push("project", { projectId: ref.projectId, section: ref.section });
          return;
        case "area":
          // An item in an area opens as its full-screen editor, like a project's.
          if (ref.section && ref.itemId) openProjectItem("", ref.section, ref.itemId);
          else push("area", { areaId: ref.areaId, section: ref.section });
          return;
        case "note":
          return openNote(ref.id);
        case "task":
          return openTask(ref.id);
        case "canvas":
          return openCanvas(ref.id);
      }
    };

    const current: NavLocation =
      routeName === "area"
        ? { kind: "area", areaId: params.areaId ?? "", section: asAreaSection(params.section) }
        : routeName === "project"
        ? {
            kind: "project",
            projectId: params.projectId ?? "",
            section: params.section as ProjectSection | undefined,
            itemId: params.itemId,
            subItemId: params.subItemId,
          }
        : routeName === "notes" || routeName === "note"
          ? { kind: "notes" }
          : routeName === "tasks" || routeName === "task"
            ? { kind: "tasks" }
            : routeName === "canvases" || routeName === "canvas"
              ? { kind: "canvases", canvasId: routeName === "canvas" ? params.id : undefined }
              : {
                  kind: "view",
                  view: (ACTIVE_VIEW[routeName] ?? routeName) as Exclude<ViewId, "notes" | "tasks" | "canvases">,
                  date: routeName === "today" ? params.date : undefined,
                  section: routeName === "settingsSection" ? params.section : undefined,
                };

    return {
      current,
      activeView: ACTIVE_VIEW[routeName] ?? (routeName as ViewId),
      visible: true,
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
      openRef,
      // No per-tab history on this shell: `openRef` already navigates (rather than pushes)
      // to a browse list, popping back to it when it is in the stack — which is what
      // replacing the current surface amounts to here.
      replaceRef: openRef,
      // No tab strip here: "open in new tab" (link chips, the calendar) opens in place.
      openInNewTab: openRef,
      openCanvas,
      addTab: () => {},
      selectTab: () => {},
      closeTab: () => {},
      expandTab: () => {},

      openProject: (projectId) => push("project", { projectId }),
      openProjectSection: (projectId, section) => push("project", { projectId, section }),
      openProjectItem,
      // A task inside a list opens as the full-screen task editor on this shell.
      openProjectSubItem: (_projectId, _section, _itemId, subItemId) => openTask(subItemId),
      openArea: (areaId) => push("area", { areaId }),
      // An item opens as its full-screen editor; a section is a tab of the project's or the
      // area's screen, so from that screen it is a param change, not another pushed copy.
      openContainer: (container, section, itemId) => {
        if (section && itemId) return openProjectItem(container.kind === "project" ? container.id : "", section, itemId);
        const name = container.kind;
        const next = container.kind === "area" ? { areaId: container.id, section: asAreaSection(section) } : { projectId: container.id, section };
        const here = routeName === name && (container.kind === "area" ? params.areaId : params.projectId) === container.id;
        if (here) navigation.setParams({ section: next.section });
        else push(name, next);
      },
    };
  }, [routeName, params.id, params.areaId, params.projectId, params.section, params.itemId, params.subItemId, state.index, navigation]);

  // Sync on navigation (§5.4), same contract as the desktop Shell. Depend on the stable
  // `trigger`, not the whole `sync` memo (see AppShell for the loop this avoids).
  const locKey = routeName + (params.id ?? "") + (params.areaId ?? "") + (params.projectId ?? "") + (params.chatId ?? "") + (params.section ?? "");
  const syncTrigger = useSync().trigger;
  useEffect(() => {
    syncTrigger();
  }, [locKey, syncTrigger]);

  return (
    <NavContext.Provider value={nav}>
      <MobileReminderBridge />
      <ThingsImportHost />
      <View style={[styles.root, { paddingTop: topInset }]}>
        <SyncHealthBanner onOpenSettings={() => nav.openRef({ kind: "view", view: "settings", section: "sync" })} />
        <PushPromptBanner />
        <View style={styles.content}>{children}</View>
      </View>
    </NavContext.Provider>
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

export function MobileWebShell({ topInset = 0, notificationScheduler, toolsStorage }: MobileWebShellProps) {
  const linking = useMemo(mobileLinking, []);
  return (
    <DensityProvider density="touch">
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
                        <Nav.Screen name="canvases" component={CanvasesListScreen} />
                        <Nav.Screen name="canvas" component={CanvasScreen} />
                        <Nav.Screen name="habits" component={HabitsScreen} />
                        <Nav.Screen name="graph" component={GraphScreen} />
                        <Nav.Screen name="logbook" component={LogbookRouteScreen} />
      <Nav.Screen name="trash" component={TrashRouteScreen} />
                        <Nav.Screen name="settings" component={SettingsListScreen} />
                        <Nav.Screen name="settingsSection" component={SettingsSectionScreen} />
                        <Nav.Screen name="notifications" component={NotificationsRouteScreen} />
                        <Nav.Screen name="install" component={InstallGuideRouteScreen} />
                        <Nav.Screen name="project" component={ProjectScreen} />
                        <Nav.Screen name="area" component={AreaScreen} />
                      </Nav.Navigator>
                    </NavigationContainer>
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
    </DensityProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceApp },
  content: { flex: 1, minHeight: 0 },
});
