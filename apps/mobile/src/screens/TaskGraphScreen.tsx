import { useCallback, useEffect, useState } from 'react';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { GraphCanvas, useCore } from '@companion/app';
import type { Graph } from '@companion/core-bridge';
import type { RootStackParamList } from '../MobileShell';

// The per-task neighborhood graph (pushed from the task editor's header). The task sits at
// the center; tapping another node pushes into it.
export function TaskGraphScreen() {
  const { params } = useRoute<RouteProp<RootStackParamList, 'TaskGraph'>>();
  const taskId = params.id;
  const { core, graph: api } = useCore();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [graph, setGraph] = useState<Graph>({ nodes: [], edges: [] });

  const refresh = useCallback(async () => setGraph(await api.neighborhood('task', taskId, 2)), [api, taskId]);
  useEffect(() => {
    void refresh();
    return core.on('data.changed', () => void refresh());
  }, [core, refresh]);

  return (
    <GraphCanvas
      graph={graph}
      focusKey={`task:${taskId}`}
      onOpenNode={(type, id) => {
        if (type === 'note') nav.push('NoteEditor', { id });
        else if (type === 'task' && id !== taskId) nav.push('TaskEditor', { id });
        else if (type === 'project') nav.push('Project', { projectId: id });
      }}
    />
  );
}
