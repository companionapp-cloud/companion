import { useCallback, useEffect } from 'react';
import { NavigationContainer, useNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import * as Notifications from 'expo-notifications';
import { colors } from '@companion/design-system';
import { taskIdFromResponse } from './notifications';
import { TrashScreen } from '@companion/app';
import { HomeScreen } from './screens/HomeScreen';
import { NotesListScreen } from './screens/NotesListScreen';
import { NoteEditorScreen } from './screens/NoteEditorScreen';
import { TasksListScreen } from './screens/TasksListScreen';
import { TaskEditorScreen } from './screens/TaskEditorScreen';
import { TaskGraphScreen } from './screens/TaskGraphScreen';
import { NoteGraphScreen } from './screens/NoteGraphScreen';
import { GraphScreen } from './screens/GraphScreen';
import { ChatScreen } from './screens/ChatScreen';
import { ChatListScreen } from './screens/ChatListScreen';
import { PlaceholderScreen } from './screens/PlaceholderScreen';
import { ProjectScreen } from './screens/ProjectScreen';
import { SettingsScreen } from './screens/SettingsScreen';

// Mobile navigation. The root is a list (HomeScreen): the global sections
// (Chat/Notes/Tasks/Calendar) plus the areas → projects tree. Global sections open as
// full stack screens; opening a project pushes ProjectScreen, which hosts a bottom tab
// bar scoped to that project (PLAN §6.6). The desktop AppShell is intentionally not
// reused; the shared data layer (Core/Sync/Notes/Projects providers) is mounted above
// this in App.tsx.

export type RootStackParamList = {
  Home: undefined;
  // Global (all-items) section screens.
  Chat: undefined;
  ChatConversation: { chatId: string };
  Notes: undefined;
  Tasks: undefined;
  Habits: undefined;
  Calendar: undefined;
  Graph: undefined;
  Trash: undefined;
  // A project and its scoped tab bar.
  Project: { projectId: string };
  // Shared detail/overlay screens.
  NoteEditor: { id: string };
  TaskEditor: { id: string };
  NoteGraph: { id: string };
  TaskGraph: { id: string };
  Settings: undefined;
};

// The tabs shown inside a project (PLAN §6.6). Notes works today; Tasks and Calendar
// are placeholders until those milestones land.
export type ProjectTabParamList = {
  ProjectNotes: undefined;
  ProjectTasks: undefined;
  ProjectCalendar: undefined;
};

const RootStack = createNativeStackNavigator<RootStackParamList>();

export function MobileShell() {
  const navigationRef = useNavigationContainerRef<RootStackParamList>();

  // Deep-link a tapped reminder to its task (PLAN §6.4). navigate() is safe to call once the
  // container is ready; guard because a cold-start tap can resolve before that.
  const openTask = useCallback(
    (taskId: string) => {
      if (navigationRef.isReady()) navigationRef.navigate('TaskEditor', { id: taskId });
    },
    [navigationRef],
  );

  // Warm taps (app already running/backgrounded).
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const taskId = taskIdFromResponse(response);
      if (taskId) openTask(taskId);
    });
    return () => sub.remove();
  }, [openTask]);

  // Cold start: app launched by tapping a reminder. Checked on container ready so navigate()
  // lands on the mounted navigator.
  const handleReady = useCallback(() => {
    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        const taskId = taskIdFromResponse(response);
        if (taskId) openTask(taskId);
      })
      .catch(() => {});
  }, [openTask]);

  return (
    <NavigationContainer ref={navigationRef} onReady={handleReady}>
      <RootStack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: colors.surfaceApp },
          headerTitleStyle: { color: colors.textPrimary },
          headerTintColor: colors.accent,
          contentStyle: { backgroundColor: colors.surfaceApp },
        }}
      >
        <RootStack.Screen name="Home" component={HomeScreen} options={{ headerShown: false }} />
        <RootStack.Screen name="Chat" component={ChatListScreen} options={{ title: 'Chat' }} />
        <RootStack.Screen name="ChatConversation" component={ChatScreen} options={{ title: '' }} />
        <RootStack.Screen name="Notes" component={NotesListScreen} options={{ title: 'All notes' }} />
        <RootStack.Screen name="Tasks" component={TasksListScreen} options={{ title: 'All tasks' }} />
        <RootStack.Screen name="Habits" component={PlaceholderScreen} options={{ title: 'Habits' }} />
        <RootStack.Screen name="Calendar" component={PlaceholderScreen} options={{ title: 'Calendar' }} />
        <RootStack.Screen name="Graph" component={GraphScreen} options={{ title: 'Graph' }} />
        <RootStack.Screen name="Trash" component={TrashScreen} options={{ title: 'Trash' }} />
        <RootStack.Screen name="Project" component={ProjectScreen} />
        <RootStack.Screen name="NoteEditor" component={NoteEditorScreen} options={{ title: '' }} />
        <RootStack.Screen name="TaskEditor" component={TaskEditorScreen} options={{ title: 'Task' }} />
        <RootStack.Screen name="NoteGraph" component={NoteGraphScreen} options={{ title: 'Graph' }} />
        <RootStack.Screen name="TaskGraph" component={TaskGraphScreen} options={{ title: 'Graph' }} />
        <RootStack.Screen
          name="Settings"
          component={SettingsScreen}
          options={{ presentation: 'modal', title: 'Settings' }}
        />
      </RootStack.Navigator>
    </NavigationContainer>
  );
}
