import { useCallback, useEffect, useState } from 'react';
import { useRoute, type RouteProp } from '@react-navigation/native';
import { GraphCanvas, useCore } from '@companion/app';
import type { Graph } from '@companion/core-bridge';
import type { RootStackParamList } from '../MobileShell';
import { useOpenGraphNode } from '../useOpenGraphNode';

// The per-note neighborhood graph (pushed from the note editor's header). The note sits
// at the center (not itself tappable); tapping another node pushes into it where it lives.
export function NoteGraphScreen() {
  const { params } = useRoute<RouteProp<RootStackParamList, 'NoteGraph'>>();
  const noteId = params.id;
  const { core, graph: api } = useCore();
  const openNode = useOpenGraphNode();
  const [graph, setGraph] = useState<Graph>({ nodes: [], edges: [] });

  const refresh = useCallback(
    async () => setGraph(await api.neighborhood('note', noteId, 2)),
    [api, noteId],
  );
  useEffect(() => {
    void refresh();
    return core.on('data.changed', () => void refresh());
  }, [core, refresh]);

  return <GraphCanvas graph={graph} focusKey={`note:${noteId}`} onOpenNode={openNode} />;
}
