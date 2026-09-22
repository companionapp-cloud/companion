import { useCallback, useEffect, useMemo } from 'react';
import { View } from 'react-native';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';
import { NavigationContainer, useNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { colors } from '@companion/design-system';
import { SyncHealthBanner, useSync } from '@companion/app';
import { stackHeader } from './ui/native';
import { HomeScreen } from './screens/HomeScreen';
import { TodayScreen } from './screens/TodayScreen';
import { CalendarScreen } from './screens/CalendarScreen';
import { CalendarEventScreen } from './screens/CalendarEventScreen';
import { NotesListScreen } from './screens/NotesListScreen';
import { NoteEditorScreen } from './screens/NoteEditorScreen';
import { TasksListScreen } from './screens/TasksListScreen';
import { CanvasesListScreen } from './screens/CanvasesListScreen';
import { CanvasScreen } from './screens/CanvasScreen';
import { NotebooksListScreen } from './screens/NotebooksListScreen';
import { NotebookScreen } from './screens/NotebookScreen';
import { NotificationsScreen } from './screens/NotificationsScreen';
import { TrashRouteScreen } from './screens/TrashRouteScreen';
import { LogbookRouteScreen } from './screens/LogbookRouteScreen';
import { TaskEditorScreen } from './screens/TaskEditorScreen';
import { TaskGraphScreen } from './screens/TaskGraphScreen';
import { NoteGraphScreen } from './screens/NoteGraphScreen';
import { GraphScreen } from './screens/GraphScreen';
import { ChatScreen } from './screens/ChatScreen';
import { ChatListScreen } from './screens/ChatListScreen';
import { PlaceholderScreen } from './screens/PlaceholderScreen';
import { ProjectScreen } from './screens/ProjectScreen';
import { AreaScreen } from './screens/AreaScreen';
import { ProjectSettingsScreen } from './screens/ProjectSettingsScreen';
import { SettingsScreen, SettingsSectionScreen } from './screens/SettingsScreen';
import type { SettingsSectionId } from '@companion/app';
import type { CalendarItem } from '@companion/core-bridge';

// Mobile navigation. The root is a list (HomeScreen): the global sections
// (Chat/Notes/Tasks/Calendar) plus the areas → projects tree. Global sections open as
// full stack screens; opening a project pushes ProjectScreen, which hosts a bottom tab
// bar scoped to that project (PLAN §6.6). The desktop AppShell is intentionally not
// reused — no rail, no tab strip; the shared data layer (Core/Sync/Notes/Projects
// providers) is mounted above this in App.tsx.
//
// Chrome: Home owns its large title and drops the bar; every other route wears the same
// 44px nav bar (ui/native's NavBar, handed to the stack as its `header`), so screens keep
// configuring it through the usual `title` / `headerRight` options.

export type RootStackParamList = {
  Home: undefined;
  // Global (all-items) section screens. Today may open on a given day (YYYY-MM-DD): a
  // daily note followed from the graph.
  Today: { date?: string } | undefined;
  Chat: undefined;
  ChatConversation: { chatId: string };
  Notes: undefined;
  Tasks: undefined;
  Canvases: undefined;
  Canvas: { id: string };
  Notebooks: undefined;
  Notebook: { id: string; page?: number };
  Habits: undefined;
  Calendar: undefined;
  CalendarEvent: { item: CalendarItem };
  Graph: undefined;
  Logbook: undefined;
  Trash: undefined;
  Notifications: undefined;
  // A project and its scoped tab bar.
  Project: { projectId: string };
  // An area's page and its scoped tab bar (PLAN-areas.md §3).
  Area: { areaId: string };
  // A project's settings (rename, reassign area, delete).
  ProjectSettings: { projectId: string };
  // Shared detail/overlay screens.
  NoteEditor: { id: string };
  TaskEditor: { id: string };
  NoteGraph: { id: string };
  TaskGraph: { id: string };
  Settings: undefined;
  SettingsSection: { section: SettingsSectionId };
};

// The tabs shown inside a project (PLAN §6.6). Notes works today; Tasks and Calendar
// are placeholders until those milestones land.
export type ProjectTabParamList = {
  ProjectOverview: undefined;
  ProjectNotes: undefined;
  ProjectTasks: undefined;
  ProjectCanvases: undefined;
  ProjectCalendar: undefined;
};

// The tabs shown inside an area: what it holds directly, never lists or calendars.
export type AreaTabParamList = {
  AreaOverview: undefined;
  AreaNotes: undefined;
  AreaTasks: undefined;
  AreaCanvases: undefined;
};

const RootStack = createNativeStackNavigator<RootStackParamList>();

export function MobileShell() {
  const navigationRef = useNavigationContainerRef<RootStackParamList>();
  const insets = useSafeAreaInsets();
  // The sync-health banner sits above the navigator and takes the top inset when it
  // shows; the nav bars beneath it must then not pad for the status bar a second time.
  // (Mirrors SyncHealthBanner's own visibility rule.)
  const sync = useSync();
  const bannerShown = sync.connected && (sync.status === 'locked' || sync.needsReauth);
  const navInsets = useMemo(() => (bannerShown ? { ...insets, top: 0 } : insets), [bannerShown, insets]);

  // Deep-link a tapped reminder to its task (PLAN §6.4). navigate() is safe to call once the
  // container is ready; guard because a cold-start tap can resolve before that.
  const openTask = useCallback(
    (taskId: string) => {
      if (navigationRef.isReady()) navigationRef.navigate('TaskEditor', { id: taskId });
    },
    [navigationRef],
  );

  // Warm taps (app already running/backgrounded).
  // TODO: re-enable when we figure out signing strategy
  // useEffect(() => {
  //   const sub = Notifications.addNotificationResponseReceivedListener((response) => {
  //     const taskId = taskIdFromResponse(response);
  //     if (taskId) openTask(taskId);
  //   });
  //   return () => sub.remove();
  // }, [openTask]);

  // // Cold start: app launched by tapping a reminder. Checked on container ready so navigate()
  // // lands on the mounted navigator.
  // TODO: re-enable when we figure out signing strategy
  // const handleReady = useCallback(() => {
  //   Notifications.getLastNotificationResponseAsync()
  //     .then((response) => {
  //       const taskId = taskIdFromResponse(response);
  //       if (taskId) openTask(taskId);
  //     })
  //     .catch(() => {});
  // }, [openTask]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.surfaceApp }}>
      {/* Global sync-health banner: prompts unlock / re-auth in Settings when sync is blocked. It
          carries the top safe-area inset so it clears the status bar when visible (§7). */}
      <SyncHealthBanner onOpenSettings={() => navigationRef.navigate('Settings')} topInset={insets.top} />
      <SafeAreaInsetsContext.Provider value={navInsets}>
        <NavigationContainer ref={navigationRef} onReady={() => void 0}>
          <RootStack.Navigator
            screenOptions={{
              header: stackHeader,
              contentStyle: { backgroundColor: colors.surfaceApp },
            }}
          >
            <RootStack.Screen name="Home" component={HomeScreen} options={{ headerShown: false }} />
            <RootStack.Screen name="Today" component={TodayScreen} options={{ title: 'Today' }} />
            <RootStack.Screen name="Chat" component={ChatListScreen} options={{ title: 'Chat' }} />
            <RootStack.Screen name="ChatConversation" component={ChatScreen} options={{ title: 'Chat' }} />
            {/* Notes and Tasks hang their segmented filter under the bar, so the bar's hairline
                moves beneath the segments (NavBarSegments draws it). */}
            <RootStack.Screen name="Notes" component={NotesListScreen} options={{ title: 'Notes', headerShadowVisible: false }} />
            <RootStack.Screen name="Tasks" component={TasksListScreen} options={{ title: 'Tasks', headerShadowVisible: false }} />
            <RootStack.Screen name="Canvases" component={CanvasesListScreen} options={{ title: 'Canvases' }} />
            <RootStack.Screen name="Canvas" component={CanvasScreen} options={{ title: 'Canvas' }} />
            <RootStack.Screen name="Notebooks" component={NotebooksListScreen} options={{ title: 'Notebooks' }} />
            <RootStack.Screen name="Notebook" component={NotebookScreen} options={{ title: 'Notebook' }} />
            <RootStack.Screen name="Habits" component={PlaceholderScreen} options={{ title: 'Habits' }} />
            <RootStack.Screen name="Calendar" component={CalendarScreen} options={{ title: 'Calendar' }} />
            <RootStack.Screen name="CalendarEvent" component={CalendarEventScreen} options={{ title: 'Event' }} />
            <RootStack.Screen name="Graph" component={GraphScreen} options={{ title: 'Graph' }} />
            <RootStack.Screen name="Logbook" component={LogbookRouteScreen} options={{ title: 'Logbook' }} />
            <RootStack.Screen name="Trash" component={TrashRouteScreen} options={{ title: 'Trash' }} />
            <RootStack.Screen name="Notifications" component={NotificationsScreen} options={{ title: 'Notifications' }} />
            <RootStack.Screen name="Project" component={ProjectScreen} options={{ title: 'Project' }} />
            <RootStack.Screen name="Area" component={AreaScreen} options={{ title: 'Area' }} />
            <RootStack.Screen name="ProjectSettings" component={ProjectSettingsScreen} options={{ title: 'Project settings' }} />
            <RootStack.Screen name="NoteEditor" component={NoteEditorScreen} options={{ title: '' }} />
            <RootStack.Screen name="TaskEditor" component={TaskEditorScreen} options={{ title: 'Task' }} />
            <RootStack.Screen name="NoteGraph" component={NoteGraphScreen} options={{ title: 'Graph' }} />
            <RootStack.Screen name="TaskGraph" component={TaskGraphScreen} options={{ title: 'Graph' }} />
            <RootStack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
            <RootStack.Screen name="SettingsSection" component={SettingsSectionScreen} options={{ title: 'Settings' }} />
          </RootStack.Navigator>
        </NavigationContainer>
      </SafeAreaInsetsContext.Provider>
    </View>
  );
}
