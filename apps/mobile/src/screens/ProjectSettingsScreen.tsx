import { useLayoutEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useProjects, DeleteProjectDialog, ProjectSchedule } from '@companion/app';
import { Button, Center, Icon, Input, Text, colors, radius, space, type PressState } from '@companion/design-system';
import type { RootStackParamList } from '../MobileShell';
import { SectionLabel } from '../ui/native';

/** A project's settings screen (PLAN §6.6): rename, schedule (start, deadline, repeat, complete
 * — PLAN-scheduling.md §2), reassign its area, and delete. Delete
 * prompts whether to keep the project's notes/tasks (they move to Unsorted) or trash them
 * too, via the shared DeleteProjectDialog. Reached from the gear button in the project header. */
export function ProjectSettingsScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { params } = useRoute<RouteProp<RootStackParamList, 'ProjectSettings'>>();
  const { projectById, areas, updateProject, deleteProject } = useProjects();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const insets = useSafeAreaInsets();
  const project = projectById(params.projectId);

  useLayoutEffect(() => {
    nav.setOptions({ title: 'Project settings' });
  }, [nav]);

  if (!project) {
    return (
      <Center>
        <Text tone="tertiary">This project is gone.</Text>
      </Center>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.surfaceApp }}>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xxl }]} keyboardShouldPersistTaps="handled">
        <SectionLabel>Name</SectionLabel>
        <Input
          value={project.name}
          placeholder="Name the project"
          leadingIcon={<Icon name="folder" size={16} color={project.color ?? colors.textTertiary} />}
          onChangeText={(t) => t.trim() && void updateProject(project.id, { name: t.trim() })}
        />

        <SectionLabel>Schedule</SectionLabel>
        <ProjectSchedule project={project} />

        <SectionLabel>Area</SectionLabel>
        <View style={styles.chips}>
          {areas.map((a) => {
            const on = a.id === project.areaId;
            return (
              <Pressable
                key={a.id}
                onPress={() => void updateProject(project.id, { areaId: a.id })}
                style={({ pressed }: PressState) => [styles.chip, on ? styles.chipOn : pressed ? styles.chipPressed : null]}
              >
                <Text variant="caption" tone={on ? 'accent' : 'secondary'}>
                  {a.name}
                </Text>
              </Pressable>
            );
          })}
          {areas.length === 0 ? (
            <Text variant="caption" tone="tertiary">
              No areas yet.
            </Text>
          ) : null}
        </View>

        <View style={styles.footer}>
          <Button label="Delete project" variant="danger" onPress={() => setConfirmDelete(true)} />
        </View>
      </ScrollView>

      {confirmDelete ? (
        <DeleteProjectDialog
          projectName={project.name}
          onConfirm={async (deleteContent) => {
            await deleteProject(project.id, deleteContent);
            // The project (and possibly its content) is gone — return to Home rather than the
            // now-empty project view.
            nav.popToTop();
          }}
          onClose={() => setConfirmDelete(false)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: space.lg },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, paddingHorizontal: space.xxs },
  // Chips are 3px-cornered; `lg` control height keeps them a comfortable touch target.
  chip: {
    minHeight: 30,
    justifyContent: 'center',
    paddingHorizontal: space.ml,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderDefault,
  },
  chipPressed: { backgroundColor: colors.surfaceActive },
  chipOn: { borderColor: colors.accentSoftBorder, backgroundColor: colors.accentSoft },
  footer: { marginTop: space.xxl, alignItems: 'flex-start' },
});
