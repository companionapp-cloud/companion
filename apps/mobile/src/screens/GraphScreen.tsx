import { useCallback, useEffect, useState } from 'react';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { GraphCanvas, useCore } from '@companion/app';
import type { Graph } from '@companion/core-bridge';
import type { RootStackParamList } from '../MobileShell';

// The whole-knowledgebase graph as a bottom tab. Same React Flow canvas as web/desktop,
// hosted in a WebView by GraphCanvas. Tapping a note opens it.
export function GraphScreen() {
  const { core, graph: api } = useCore();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [graph, setGraph] = useState<Graph>({ nodes: [], edges: [] });

  const refresh = useCallback(async () => setGraph(await api.full()), [api]);
  useEffect(() => {
    void refresh();
    // Stay live as notes are edited, synced, or the index is rebuilt (PLAN §5.4).
    return core.on('data.changed', () => void refresh());
  }, [core, refresh]);

  return (
    <GraphCanvas
      graph={graph}
      onOpenNode={(type, id) => {
        if (type === 'note') nav.navigate('NoteEditor', { id });
        else if (type === 'task') nav.navigate('TaskEditor', { id });
        else if (type === 'project') nav.navigate('Project', { projectId: id });
      }}
    />
  );
}
