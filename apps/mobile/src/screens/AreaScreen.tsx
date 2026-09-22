import { useLayoutEffect } from 'react';
import { StyleSheet } from 'react-native';
import { createBottomTabNavigator, type BottomTabBarButtonProps } from '@react-navigation/bottom-tabs';
import { PlatformPressable } from '@react-navigation/elements';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import { TourAnchor, useProjects } from '@companion/app';
import { Icon, colors, font, type IconName } from '@companion/design-system';
import type { AreaTabParamList, RootStackParamList } from '../MobileShell';
import { AreaContext } from '../ProjectContext';
import { ContainerOverviewScreen } from './ContainerOverviewScreen';
import { NotesListScreen } from './NotesListScreen';
import { TasksListScreen } from './TasksListScreen';
import { CanvasesListScreen } from './CanvasesListScreen';

const Tabs = createBottomTabNavigator<AreaTabParamList>();

// `section` names the tab the way the area page does everywhere, so the tutorial finds it.
const TAB: Record<keyof AreaTabParamList, { label: string; icon: IconName; section: string }> = {
  AreaOverview: { label: 'Overview', icon: 'folder', section: 'overview' },
  AreaNotes: { label: 'Notes', icon: 'notes', section: 'notes' },
  AreaTasks: { label: 'Tasks', icon: 'tasks', section: 'tasks' },
  AreaCanvases: { label: 'Canvases', icon: 'canvas', section: 'canvases' },
};

/** An area's page (PLAN-areas.md §3): an Overview tab, then the three things an area holds
 * directly — notes, tasks and canvases, never lists or calendars. The lists are scoped through
 * AreaContext and roll up the area's projects' content; what they create is filed in the area. */
export function AreaScreen({ route }: NativeStackScreenProps<RootStackParamList, 'Area'>) {
  const { areaId } = route.params;
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { areas } = useProjects();
  const area = areas.find((a) => a.id === areaId);
  const title = area ? (area.icon ? `${area.icon} ${area.name}` : area.name) : 'Area';

  useLayoutEffect(() => {
    nav.setOptions({ title });
  }, [nav, title]);

  return (
    <AreaContext.Provider value={areaId}>
      <Tabs.Navigator
        screenOptions={({ route: tabRoute }) => ({
          headerShown: false,
          tabBarActiveTintColor: colors.textAccent,
          tabBarInactiveTintColor: colors.textTertiary,
          tabBarStyle: styles.tabBar,
          tabBarLabelStyle: styles.tabLabel,
          tabBarLabel: TAB[tabRoute.name as keyof AreaTabParamList].label,
          tabBarIcon: ({ color }) => <Icon name={TAB[tabRoute.name as keyof AreaTabParamList].icon} size={20} color={color} />,
          // Each tab is a tutorial anchor (the area tutorial walks the bar).
          tabBarButton: (props: BottomTabBarButtonProps) => (
            <TourAnchor id={`page.section.${TAB[tabRoute.name as keyof AreaTabParamList].section}`} style={styles.tab}>
              <PlatformPressable {...props} />
            </TourAnchor>
          ),
        })}
      >
        <Tabs.Screen name="AreaOverview" component={ContainerOverviewScreen} />
        <Tabs.Screen name="AreaNotes" component={NotesListScreen} />
        <Tabs.Screen name="AreaTasks" component={TasksListScreen} />
        <Tabs.Screen name="AreaCanvases" component={CanvasesListScreen} />
      </Tabs.Navigator>
    </AreaContext.Provider>
  );
}

const styles = StyleSheet.create({
  // Flat chrome: a hairline, no shadow (matches ProjectScreen).
  tabBar: {
    backgroundColor: colors.surfaceApp,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    elevation: 0,
    shadowOpacity: 0,
  },
  tabLabel: { fontFamily: font.mono, fontSize: font.size['2xs'] },
  // The anchor takes the tab's place in the bar.
  tab: { flex: 1 },
});
