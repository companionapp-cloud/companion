import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Icon, IconButton, colors, type IconName } from '@companion/design-system';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { NotesListScreen } from './screens/NotesListScreen';
import { NoteEditorScreen } from './screens/NoteEditorScreen';
import { PlaceholderScreen } from './screens/PlaceholderScreen';
import { SettingsScreen } from './screens/SettingsScreen';

// Mobile navigation (bottom tabs + stack). Unlike the desktop AppShell (rail +
// split-view + note tabs + window chrome), phones drill list → editor via a stack and
// switch sections via a bottom tab bar. The shared data layer (Core/Notes/Sync
// providers) is mounted above this in App.tsx.

export type RootStackParamList = {
  Main: undefined;
  NoteEditor: { id: string };
  Settings: undefined;
};

export type TabParamList = {
  Notes: undefined;
  Chat: undefined;
  Calendar: undefined;
  Tasks: undefined;
};

const RootStack = createNativeStackNavigator<RootStackParamList>();
const Tabs = createBottomTabNavigator<TabParamList>();

const TAB_ICON: Record<keyof TabParamList, IconName> = {
  Notes: 'notes',
  Chat: 'chat',
  Calendar: 'calendar',
  Tasks: 'tasks',
};

// Opens Settings from a tab header; navigates up to the root stack.
function SettingsButton() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  return (
    <IconButton label="Settings" size="sm" onPress={() => nav.navigate('Settings')}>
      <Icon name="settings" size={18} color={colors.textSecondary} />
    </IconButton>
  );
}

function MainTabs() {
  return (
    <Tabs.Navigator
      screenOptions={({ route }) => ({
        headerRight: () => <SettingsButton />,
        headerTitleStyle: { color: colors.textPrimary },
        headerStyle: { backgroundColor: colors.surfaceApp },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textTertiary,
        tabBarStyle: { backgroundColor: colors.surfaceApp, borderTopColor: colors.borderSubtle },
        tabBarIcon: ({ color }) => <Icon name={TAB_ICON[route.name]} size={22} color={color} />,
      })}
    >
      <Tabs.Screen name="Chat" component={PlaceholderScreen} />
      <Tabs.Screen name="Calendar" component={PlaceholderScreen} />
      <Tabs.Screen name="Notes" component={NotesListScreen} />
      <Tabs.Screen name="Tasks" component={PlaceholderScreen} />
    </Tabs.Navigator>
  );
}

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
        <RootStack.Screen name="Main" component={MainTabs} options={{ headerShown: false }} />
        <RootStack.Screen name="NoteEditor" component={NoteEditorScreen} options={{ title: '' }} />
        <RootStack.Screen
          name="Settings"
          component={SettingsScreen}
          options={{ presentation: 'modal', title: 'Settings' }}
        />
      </RootStack.Navigator>
    </NavigationContainer>
  );
}
