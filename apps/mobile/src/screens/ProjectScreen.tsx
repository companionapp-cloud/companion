import { useLayoutEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import { useProjects } from '@companion/app';
import { Icon, Text, colors, font, type IconName } from '@companion/design-system';
import type { ProjectTabParamList, RootStackParamList } from '../MobileShell';
import { ProjectContext } from '../ProjectContext';
import { NavAction } from '../ui/native';
import { NotesListScreen } from './NotesListScreen';
import { TasksListScreen } from './TasksListScreen';
import { CanvasesListScreen } from './CanvasesListScreen';
import { PlaceholderScreen } from './PlaceholderScreen';

const Tabs = createBottomTabNavigator<ProjectTabParamList>();

const TAB: Record<keyof ProjectTabParamList, { label: string; icon: IconName }> = {
  ProjectNotes: { label: 'Notes', icon: 'notes' },
  ProjectTasks: { label: 'Tasks', icon: 'tasks' },
  ProjectCanvases: { label: 'Canvases', icon: 'canvas' },
  ProjectCalendar: { label: 'Calendar', icon: 'calendar' },
};

/** A project's scoped view: a bottom tab bar (Notes / Tasks / Canvases / Calendar) filtered
 * to this project via ProjectContext (PLAN §6.6). The nav bar shows the project name over
 * its area in mono; the tab screens themselves render headerless. */
export function ProjectScreen({ route }: NativeStackScreenProps<RootStackParamList, 'Project'>) {
  const { projectId } = route.params;
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { projects, areas } = useProjects();
  const project = projects.find((p) => p.id === projectId);
  const areaName = project ? areas.find((a) => a.id === project.areaId)?.name : undefined;

  // A two-line title (project name + its area in mono) and the settings action.
  useLayoutEffect(() => {
    nav.setOptions({
      headerTitle: () => (
        <View>
          <Text variant="title" numberOfLines={1}>
            {project?.name ?? 'Project'}
          </Text>
          {areaName ? (
            <Text variant="mono" tone="tertiary" numberOfLines={1}>
              {areaName}
            </Text>
          ) : null}
        </View>
      ),
      headerRight: () => (
        <NavAction icon="settings" label="Project settings" onPress={() => nav.navigate('ProjectSettings', { projectId })} />
      ),
    });
  }, [nav, project?.name, areaName, projectId]);

  return (
    <ProjectContext.Provider value={projectId}>
      <Tabs.Navigator
        screenOptions={({ route: tabRoute }) => ({
          headerShown: false,
          // Selected reads as it does everywhere: accent text and icon, nothing else moves.
          tabBarActiveTintColor: colors.textAccent,
          tabBarInactiveTintColor: colors.textTertiary,
          tabBarStyle: styles.tabBar,
          tabBarLabelStyle: styles.tabLabel,
          tabBarLabel: TAB[tabRoute.name as keyof ProjectTabParamList].label,
          tabBarIcon: ({ color }) => (
            <Icon name={TAB[tabRoute.name as keyof ProjectTabParamList].icon} size={20} color={color} />
          ),
        })}
      >
        <Tabs.Screen name="ProjectNotes" component={NotesListScreen} />
        <Tabs.Screen name="ProjectTasks" component={TasksListScreen} />
        <Tabs.Screen name="ProjectCanvases" component={CanvasesListScreen} />
        <Tabs.Screen name="ProjectCalendar" component={PlaceholderScreen} />
      </Tabs.Navigator>
    </ProjectContext.Provider>
  );
}

const styles = StyleSheet.create({
  // Flat chrome: a hairline, no shadow.
  tabBar: {
    backgroundColor: colors.surfaceApp,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    elevation: 0,
    shadowOpacity: 0,
  },
  tabLabel: { fontFamily: font.mono, fontSize: font.size['2xs'] },
});
