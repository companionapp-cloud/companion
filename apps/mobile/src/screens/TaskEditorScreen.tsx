import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTasks, TaskEditor, MembershipPicker, ConfirmDialog } from '@companion/app';
import type { LinkRef } from '@companion/editor';
import { Center, Icon, IconButton, Text, colors, space } from '@companion/design-system';
import type { RootStackParamList } from '../MobileShell';

// Full-screen editor for one task (PLAN §6.4). Task-scoped actions (add to projects,
// delete) live in the nav header; the shared TaskEditor renders headerless here.
export function TaskEditorScreen() {
  const store = useTasks();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { params } = useRoute<RouteProp<RootStackParamList, 'TaskEditor'>>();
  const taskId = params.id;
  const task = store.byId(taskId);
  const [showProjects, setShowProjects] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // `store` gets a new identity on each save, so route delete through a ref to keep the
  // header callback stable.
  const storeRef = useRef(store);
  storeRef.current = store;

  // Clicking a chip in the notes pushes its target onto the stack (tasks and notes have screens).
  const onOpenRef = useCallback(
    (ref: LinkRef) => {
      if (ref.type === 'task') nav.push('TaskEditor', { id: ref.id });
      else if (ref.type === 'note') nav.push('NoteEditor', { id: ref.id });
    },
    [nav],
  );

  useLayoutEffect(() => {
    nav.setOptions({
      title: task?.title || 'Task',
      headerRight: () => (
        <View style={styles.headerActions}>
          <IconButton label="Add to projects" size="sm" onPress={() => setShowProjects(true)}>
            <Icon name="folder" size={18} color={colors.textSecondary} />
          </IconButton>
          <IconButton label="Task graph" size="sm" onPress={() => nav.navigate('TaskGraph', { id: taskId })}>
            <Icon name="graph" size={18} color={colors.textSecondary} />
          </IconButton>
          <IconButton label="Delete task" size="sm" onPress={() => setConfirmDelete(true)}>
            <Icon name="trash" size={18} color={colors.textSecondary} />
          </IconButton>
        </View>
      ),
    });
  }, [nav, task?.title]);

  if (!task) {
    return (
      <Center>
        <Text tone="tertiary">This task is gone.</Text>
      </Center>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.surfaceCard }}>
      <TaskEditor
        task={task}
        save={store.update}
        showToolbar={false}
        onOpenRef={onOpenRef}
        onConnectSync={() => nav.navigate('SettingsSection', { section: 'sync' })}
      />
      {showProjects ? (
        <MembershipPicker entityType="task" entityId={taskId} onClose={() => setShowProjects(false)} />
      ) : null}
      {confirmDelete ? (
        <ConfirmDialog
          title="Delete task?"
          message="This task moves to the Trash and is permanently deleted after 30 days. You can restore it from the Trash until then."
          confirmLabel="Delete task"
          onConfirm={async () => {
            await storeRef.current.remove(taskId);
            nav.goBack();
          }}
          onClose={() => setConfirmDelete(false)}
        />
      ) : null}
    </View>
  );
}

const styles = {
  headerActions: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: space.xs },
};
