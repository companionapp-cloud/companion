import { useCallback, useEffect, useState } from 'react';
import { useRoute, type RouteProp } from '@react-navigation/native';
import { GraphCanvas, useCore } from '@companion/app';
import type { Graph } from '@companion/core-bridge';
import type { RootStackParamList } from '../MobileShell';
import { useOpenGraphNode } from '../useOpenGraphNode';

// The per-task neighborhood graph (pushed from the task editor's header). The task sits at
// the center (not itself tappable); tapping another node pushes into it where it lives.
export function TaskGraphScreen() {
  const { params } = useRoute<RouteProp<RootStackParamList, 'TaskGraph'>>();
  const taskId = params.id;
  const { core, graph: api } = useCore();
  const openNode = useOpenGraphNode();
  const [graph, setGraph] = useState<Graph>({ nodes: [], edges: [] });

  const refresh = useCallback(async () => setGraph(await api.neighborhood('task', taskId, 2)), [api, taskId]);
  useEffect(() => {
    void refresh();
    return core.on('data.changed', () => void refresh());
  }, [core, refresh]);

  return <GraphCanvas graph={graph} focusKey={`task:${taskId}`} onOpenNode={openNode} />;
}
