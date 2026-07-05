import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { colors } from '@companion/design-system';
import { TrashScreen } from '@companion/app';
import { HomeScreen } from './screens/HomeScreen';
import { NotesListScreen } from './screens/NotesListScreen';
import { NoteEditorScreen } from './screens/NoteEditorScreen';
import { NoteGraphScreen } from './screens/NoteGraphScreen';
import { GraphScreen } from './screens/GraphScreen';
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
  NoteGraph: { id: string };
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
  return (
    <NavigationContainer>
      <RootStack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: colors.surfaceApp },
          headerTitleStyle: { color: colors.textPrimary },
          headerTintColor: colors.accent,
          contentStyle: { backgroundColor: colors.surfaceApp },
        }}
      >
        <RootStack.Screen name="Home" component={HomeScreen} options={{ headerShown: false }} />
        <RootStack.Screen name="Chat" component={PlaceholderScreen} options={{ title: 'Chat' }} />
        <RootStack.Screen name="Notes" component={NotesListScreen} options={{ title: 'All notes' }} />
        <RootStack.Screen name="Tasks" component={PlaceholderScreen} options={{ title: 'Tasks' }} />
        <RootStack.Screen name="Habits" component={PlaceholderScreen} options={{ title: 'Habits' }} />
        <RootStack.Screen name="Calendar" component={PlaceholderScreen} options={{ title: 'Calendar' }} />
        <RootStack.Screen name="Graph" component={GraphScreen} options={{ title: 'Graph' }} />
        <RootStack.Screen name="Trash" component={TrashScreen} options={{ title: 'Trash' }} />
        <RootStack.Screen name="Project" component={ProjectScreen} />
        <RootStack.Screen name="NoteEditor" component={NoteEditorScreen} options={{ title: '' }} />
        <RootStack.Screen name="NoteGraph" component={NoteGraphScreen} options={{ title: 'Graph' }} />
        <RootStack.Screen
          name="Settings"
          component={SettingsScreen}
          options={{ presentation: 'modal', title: 'Settings' }}
        />
      </RootStack.Navigator>
    </NavigationContainer>
  );
}
