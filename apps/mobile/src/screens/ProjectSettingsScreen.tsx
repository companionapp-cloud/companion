import { useLayoutEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useProjects, DeleteProjectDialog } from '@companion/app';
import { Button, Center, Text, TextField, colors, radius, space } from '@companion/design-system';
import type { RootStackParamList } from '../MobileShell';
import { SectionLabel } from '../ui/native';

/** A project's settings screen (PLAN §6.6): rename, reassign its area, and delete. Delete
 * prompts whether to keep the project's notes/tasks (they move to Unsorted) or trash them
 * too, via the shared DeleteProjectDialog. Reached from the gear button in the project header. */
export function ProjectSettingsScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { params } = useRoute<RouteProp<RootStackParamList, 'ProjectSettings'>>();
  const { projects, areas, updateProject, deleteProject } = useProjects();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const project = projects.find((p) => p.id === params.projectId);

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
      <ScrollView contentContainerStyle={styles.content}>
        <SectionLabel>Name</SectionLabel>
        <View style={styles.titleRow}>
          <View style={[styles.dot, { backgroundColor: project.color ?? colors.borderStrong }]} />
          <TextField
            variant="title"
            value={project.name}
            placeholder="Project name"
            onChangeText={(t) => t.trim() && void updateProject(project.id, { name: t.trim() })}
          />
        </View>

        <SectionLabel>Area</SectionLabel>
        <View style={styles.chips}>
          {areas.map((a) => {
            const on = a.id === project.areaId;
            return (
              <Pressable
                key={a.id}
                onPress={() => void updateProject(project.id, { areaId: a.id })}
                style={[styles.chip, on ? styles.chipOn : null]}
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
  content: { padding: space.xl, gap: space.md },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  dot: { width: 12, height: 12, borderRadius: radius.full, flexShrink: 0 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: { paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.full, borderWidth: 1, borderColor: colors.borderDefault },
  chipOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  footer: { marginTop: space.xxl, alignItems: 'flex-start' },
});
