import { useCallback, useEffect, useState } from 'react';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { GraphCanvas, useCore } from '@companion/app';
import type { Graph } from '@companion/core-bridge';
import type { RootStackParamList } from '../MobileShell';

// The per-note neighborhood graph (pushed from the note editor's header). The note sits
// at the center; tapping another note pushes into it.
export function NoteGraphScreen() {
  const { params } = useRoute<RouteProp<RootStackParamList, 'NoteGraph'>>();
  const noteId = params.id;
  const { core, graph: api } = useCore();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [graph, setGraph] = useState<Graph>({ nodes: [], edges: [] });

  const refresh = useCallback(
    async () => setGraph(await api.neighborhood('note', noteId, 2)),
    [api, noteId],
  );
  useEffect(() => {
    void refresh();
    return core.on('data.changed', () => void refresh());
  }, [core, refresh]);

  return (
    <GraphCanvas
      graph={graph}
      focusKey={`note:${noteId}`}
      onOpenNode={(type, id) => {
        if (type === 'note' && id !== noteId) nav.push('NoteEditor', { id });
      }}
    />
  );
}
