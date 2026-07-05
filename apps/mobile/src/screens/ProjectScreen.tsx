import { useLayoutEffect } from 'react';
import { Platform, View } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useProjects } from '@companion/app';
import { Icon, Text, colors, font, type IconName } from '@companion/design-system';
import type { ProjectTabParamList, RootStackParamList } from '../MobileShell';
import { ProjectContext } from '../ProjectContext';
import { NotesListScreen } from './NotesListScreen';
import { TasksListScreen } from './TasksListScreen';
import { PlaceholderScreen } from './PlaceholderScreen';

const Tabs = createBottomTabNavigator<ProjectTabParamList>();

const TAB: Record<keyof ProjectTabParamList, { label: string; icon: IconName }> = {
  ProjectNotes: { label: 'Notes', icon: 'notes' },
  ProjectTasks: { label: 'Tasks', icon: 'tasks' },
  ProjectCalendar: { label: 'Calendar', icon: 'calendar' },
};

/** A project's scoped view: a bottom tab bar (Notes / Tasks / Calendar) filtered to
 * this project via ProjectContext (PLAN §6.6). The stack header shows the project name;
 * the tab screens themselves render headerless. */
export function ProjectScreen({ route }: NativeStackScreenProps<RootStackParamList, 'Project'>) {
  const { projectId } = route.params;
  const nav = useNavigation();
  const { projects, areas } = useProjects();
  const project = projects.find((p) => p.id === projectId);
  const areaName = project ? areas.find((a) => a.id === project.areaId)?.name : undefined;

  // A two-line header (project name + its area), aligned per platform convention.
  useLayoutEffect(() => {
    nav.setOptions({
      headerTitle: () => (
        <View style={{ alignItems: Platform.OS === 'ios' ? 'center' : 'flex-start' }}>
          <Text style={{ fontSize: 16, fontWeight: font.weight.semibold, color: colors.textPrimary }} numberOfLines={1}>
            {project?.name ?? 'Project'}
          </Text>
          {areaName ? (
            <Text variant="mono" style={{ fontSize: 11, color: colors.textTertiary }} numberOfLines={1}>
              {areaName}
            </Text>
          ) : null}
        </View>
      ),
    });
  }, [nav, project?.name, areaName]);

  return (
    <ProjectContext.Provider value={projectId}>
      <Tabs.Navigator
        screenOptions={({ route: tabRoute }) => ({
          headerShown: false,
          tabBarActiveTintColor: colors.accent,
          tabBarInactiveTintColor: colors.textTertiary,
          tabBarStyle: { backgroundColor: colors.surfaceApp, borderTopColor: colors.borderSubtle },
          tabBarLabel: TAB[tabRoute.name as keyof ProjectTabParamList].label,
          tabBarIcon: ({ color }) => (
            <Icon name={TAB[tabRoute.name as keyof ProjectTabParamList].icon} size={22} color={color} />
          ),
        })}
      >
        <Tabs.Screen name="ProjectNotes" component={NotesListScreen} />
        <Tabs.Screen name="ProjectTasks" component={TasksListScreen} />
        <Tabs.Screen name="ProjectCalendar" component={PlaceholderScreen} />
      </Tabs.Navigator>
    </ProjectContext.Provider>
  );
}
